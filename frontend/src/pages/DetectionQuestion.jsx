import { useNavigate, useLocation } from "react-router-dom";
import { useState, useEffect, useMemo, useRef } from "react";
import { getQuestions, diagnose } from "../services/api";
import { supabase } from "../services/supabaseClient";
import "../css/DetectionQuestionCSS.css";

// ============================================================
// localStorage draft helpers
// ============================================================
const LS_DRAFT_KEY = "quiz_draft";

function saveDraft(data) {
  try { localStorage.setItem(LS_DRAFT_KEY, JSON.stringify(data)); } catch (_) {}
}
function loadDraft() {
  try {
    const raw = localStorage.getItem(LS_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Jangan restore draft yang sudah selesai (completed)
    if (parsed.completed) return null;
    return parsed;
  } catch (_) { return null; }
}
function clearDraft() {
  localStorage.removeItem(LS_DRAFT_KEY);
}

// ============================================================
// Fallback label penyakit (sesuaikan dengan disease_id kamu)
// ============================================================
const DISEASE_LABELS = {
  1: "Insecure",
  2: "Fobia Sosial / Anti Sosial",
  3: "Skizofrenia",
  4: "Bipolar",
  5: "Gangguan Stres Pasca-trauma (PTSD)",
  6: "Agorafobia",
  7: "Depression",
  8: "Obsessive Compulsive Disorder (OCD)",
  9: "Anxiety Disorder",
};

export default function Detection() {
  useEffect(() => { document.title = "Tes Gejala | Vimind"; }, []);

  const navigate = useNavigate();
  const location = useLocation();
  const initDone = useRef(false); // Cegah auto-save selama init

  const [questions, setQuestions]               = useState([]);
  const [selectedAnswers, setSelectedAnswers]   = useState({});
  const [currentPage, setCurrentPage]           = useState(0);
  const [loading, setLoading]                   = useState(true);
  const [submitting, setSubmitting]             = useState(false);
  const [userEmail, setUserEmail]               = useState(null);
  const [isRefinedMode, setIsRefinedMode]       = useState(false);
  const [historyDiseaseID, setHistoryDiseaseID] = useState(0);
  const [isOffline, setIsOffline]               = useState(!navigator.onLine);
  const [retryAnswers, setRetryAnswers]         = useState(null);

  // ============================================================
  // Group questions by disease_id & batasi maksimal 5 soal per halaman
  // ============================================================
  const pages = useMemo(() => {
    const tempGroups = new Map();

    // 1. Kumpulkan soal berdasarkan penyakit
    questions.forEach((q) => {
      const key = q.disease_id ?? "unknown";
      if (!tempGroups.has(key)) {
        tempGroups.set(key, {
          disease_id: key,
          disease_name: q.disease_name || DISEASE_LABELS[key] || `Penyakit ${key}`,
          questions: [],
        });
      }
      tempGroups.get(key).questions.push(q);
    });

    // 2. Pecah setiap kelompok penyakit menjadi sub-kelompok (maks 5 soal)
    const chunkedPages = [];
    tempGroups.forEach((group) => {
      const totalQuestions = group.questions.length;
      for (let i = 0; i < totalQuestions; i += 5) {
        chunkedPages.push({
          disease_id: group.disease_id,
          disease_name: group.disease_name,
          questions: group.questions.slice(i, i + 5),
          part: Math.floor(i / 5) + 1, // Bagian ke-berapa dari penyakit ini
          totalParts: Math.ceil(totalQuestions / 5) // Total bagian dari penyakit ini
        });
      }
    });

    return chunkedPages;
  }, [questions]);

  const currentGroup     = pages[currentPage] || { questions: [], disease_name: "", disease_id: null, part: 1, totalParts: 1 };
  const currentQuestions = currentGroup.questions;
  const totalPages       = pages.length;

  // ============================================================
  // Online / Offline detection
  // ============================================================
  useEffect(() => {
    const goOnline  = () => setIsOffline(false);
    const goOffline = () => setIsOffline(true);
    window.addEventListener("online",  goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online",  goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  // Auto-retry saat kembali online
  useEffect(() => {
    if (!isOffline && retryAnswers) {
      finalizeDiagnosis(retryAnswers, true);
    }
  }, [isOffline, retryAnswers]);

  // ============================================================
  // Init — load questions + cek draft
  // ============================================================
  useEffect(() => {
    let ignore = false;

    const init = async () => {
      // Reset questions dulu agar tidak ada render dengan stale data
      setQuestions([]);
      setSelectedAnswers({});

      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (ignore) return;

        let email = "";
        if (session?.user) {
          email = session.user.email;
          setUserEmail(email);
        }

        const isGuest = !email;
        const forceNewTest = location.state?.forceNewTest;
        // sessionStorage hilang saat tab ditutup, tapi bertahan saat refresh
        const isOngoingSession = sessionStorage.getItem("quiz_active") === "true";

        // Helper: mulai tes bersih
        const startFresh = async () => {
          clearDraft();
          setCurrentPage(0);
          setIsRefinedMode(false);
          setHistoryDiseaseID(0);
          sessionStorage.setItem("quiz_active", "true");

          const res = await getQuestions("all");
          if (ignore) return;
          const qs = res.data?.questions || res.data || [];
          if (!ignore) setQuestions(qs);
        };

        // ── GUEST USER: Selalu mulai tes baru ──
        if (isGuest) {
          await startFresh();
          return;
        }

        // ── LOGGED-IN + Eksplisit "Deteksi Penyakit Baru" ──
        if (forceNewTest === true) {
          await startFresh();
          return;
        }

        // ── LOGGED-IN + "Lanjutkan Kondisi" ATAU refresh mid-test ──
        if (forceNewTest === false || (forceNewTest === undefined && isOngoingSession)) {
          const draft = loadDraft();
          if (draft && draft.questions?.length > 0) {
            setQuestions(draft.questions);
            setSelectedAnswers(draft.selectedAnswers || {});
            setCurrentPage(draft.currentPage || 0);
            setIsRefinedMode(draft.isRefinedMode || false);
            setHistoryDiseaseID(draft.historyDiseaseID || 0);
            sessionStorage.setItem("quiz_active", "true");
            return;
          }

          // Draft kosong → muat soal refined dari history
          let qs = [];
          try {
            const response = await getQuestions("refined", [], email);
            if (ignore) return;
            const { questions: refinedQs, is_refined } = response.data;
            if (refinedQs && refinedQs.length > 0) {
              qs = refinedQs;
              if (is_refined) {
                setIsRefinedMode(true);
                if (response.data.history_disease_id > 0) {
                  setHistoryDiseaseID(response.data.history_disease_id);
                }
              }
            } else {
              throw new Error("No refined questions");
            }
          } catch {
            const fallback = await getQuestions("all");
            if (ignore) return;
            qs = fallback.data?.questions || fallback.data || [];
          }
          sessionStorage.setItem("quiz_active", "true");
          if (!ignore) setQuestions(qs);
          return;
        }

        // ── LOGGED-IN + akses langsung tanpa state, tanpa session aktif ──
        await startFresh();
      } catch (err) {
        if (!ignore) console.error("Initialization failed:", err);
      } finally {
        if (!ignore) {
          setLoading(false);
          initDone.current = true; // Auto-save sekarang boleh jalan
        }
      }
    };

    initDone.current = false;
    init();
    return () => { ignore = true; };
  }, [location.state]);

  // Simpan draft setiap kali state penting berubah (HANYA setelah init selesai)
  useEffect(() => {
    if (!initDone.current) return;
    if (questions.length > 0) {
      saveDraft({ questions, selectedAnswers, currentPage, isRefinedMode, historyDiseaseID });
    }
  }, [selectedAnswers, currentPage, questions, isRefinedMode, historyDiseaseID]);

  // ============================================================
  // Helpers
  // ============================================================
  const isCurrentPageComplete = currentQuestions.every(
    (q) => selectedAnswers[q.id] !== undefined
  );

  const handleSelectOption = (questionId, value) => {
    setSelectedAnswers((prev) => ({ ...prev, [questionId]: value }));
  };

  // ============================================================
  // Next Page / Submit — langsung diagnosa di halaman terakhir
  // ============================================================
  const handleNextPage = async () => {
    if (!isCurrentPageComplete) return;

    if (currentPage >= totalPages - 1) {
      // Bobot CF User (Certainty Factor metodologi standar)
      // Opsi 1 (Setuju)         → 1.0  = User yakin punya gejala ini
      // Opsi 2 (Cukup Setuju)   → 0.6  = User cukup merasakan
      // Opsi 3 (Kurang Setuju)  → 0.2  = User sedikit merasakan
      // Opsi 4 (Tidak Setuju)   → 0.0  = User TIDAK punya gejala (HARUS NOL!)
      //
      // PENTING: level_category di DB (0.855/0.555/0.305/0.15) adalah
      // klasifikasi LEVEL DIAGNOSIS (output), BUKAN bobot jawaban user!
      const weights = { 1: 1.0, 2: 0.6, 3: 0.2, 4: 0.0 };
      const finalAnswers = questions.map((q) => ({
        symptom_id: q.id,
        value: weights[selectedAnswers[q.id]] ?? 0,
        disease_id: q.disease_id || 0,
      }));
      await finalizeDiagnosis(finalAnswers);
    } else {
      setCurrentPage((prev) => prev + 1);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  // ============================================================
  // Finalize Diagnosis
  // ============================================================
  const finalizeDiagnosis = async (finalAnswers, isRetry = false) => {
    if (!isRetry) setSubmitting(true);

    const apiAnswers = finalAnswers.map(({ symptom_id, value }) => ({ symptom_id, value }));

    if (!navigator.onLine) {
      localStorage.setItem("pending_answers", JSON.stringify(apiAnswers));
      setRetryAnswers(finalAnswers);
      setSubmitting(false);
      return;
    }

    try {
      const result = await diagnose(apiAnswers, userEmail, historyDiseaseID);

      if (userEmail) {
        localStorage.setItem("latest_diagnosis", JSON.stringify(result.data));
        localStorage.removeItem("pending_answers");
      } else {
        localStorage.removeItem("latest_diagnosis");
        localStorage.setItem("pending_answers", JSON.stringify(apiAnswers));
      }

      clearDraft();
      sessionStorage.removeItem("quiz_active");
      setRetryAnswers(null);
      navigate("/selesai", { state: { diagnosis: result.data, isGuest: !userEmail } });
    } catch (err) {
      console.error("Diagnosis failed:", err);
      localStorage.setItem("pending_answers", JSON.stringify(apiAnswers));
      setRetryAnswers(finalAnswers);
      setSubmitting(false);
    }
  };

  // ============================================================
  // Prev Page & Exit
  // ============================================================
  const handlePrevPage = () => {
    if (currentPage > 0) {
      setCurrentPage((prev) => prev - 1);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  const handleExit = () => {
    if (userEmail) navigate("/dashboard");
    else navigate("/");
  };

  // ============================================================
  // Label tombol Next
  // ============================================================
  const getNextButtonLabel = () => {
    if (submitting) return "Mengolah...";
    if (currentPage < totalPages - 1) {
      const nextGroup = pages[currentPage + 1];
      if (nextGroup.disease_id === currentGroup.disease_id) {
        return "Halaman Selanjutnya";
      }
      return `Selanjutnya: ${nextGroup.disease_name}`;
    }
    return "Selesai & Lihat Hasil";
  };

  // ============================================================
  // Render — Loading
  // ============================================================
  if (loading) return (
    <div className="question-page" style={{ justifyContent: "center" }}>
      <h1>Memuat Pertanyaan...</h1>
      <p style={{ marginTop: "10px", color: "#666" }}>Mohon tunggu sebentar.</p>
    </div>
  );

  if (!questions || questions.length === 0) return (
    <div className="question-page" style={{ justifyContent: "center" }}>
      <h1>Terjadi Kesalahan</h1>
      <p>Gagal memuat daftar pertanyaan. Silahkan coba lagi nanti.</p>
      <button onClick={() => window.location.reload()} className="next-btn" style={{ marginTop: "20px" }}>
        Muat Ulang
      </button>
    </div>
  );

  const progressPercent = ((currentPage + 1) / totalPages) * 100;

  // ============================================================
  // Render — Main
  // ============================================================
  return (
    <div className="question-page">
      {/* BANNER OFFLINE */}
      {isOffline && (
        <div className="offline-banner">
          📵 Koneksi terputus — jawabanmu tersimpan otomatis. Akan dilanjutkan saat kembali online.
        </div>
      )}
      {!isOffline && retryAnswers && (
        <div className="retry-banner">
          🔄 Koneksi kembali! Mengirim jawaban...
        </div>
      )}

      {/* TOMBOL KELUAR */}
      <button className="back-btn" onClick={handleExit}>Keluar</button>

      {/* PROGRESS BAR */}
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${progressPercent}%` }}></div>
      </div>

      <div className="question-container">
        {/* NAMA PENYAKIT & INDIKATOR BAGIAN */}
        <div className="phase-indicator">
          {currentGroup.disease_name.toUpperCase()}
          {currentGroup.totalParts > 1 ? ` (BAGIAN ${currentGroup.part})` : ""}
        </div>

        {/* SUB-INFO: bagian ke-berapa + jumlah soal di halaman ini */}
        <div style={{ textAlign: "center", color: "#888", fontSize: "13px", marginBottom: "16px" }}>
          Halaman {currentPage + 1} dari {totalPages} &nbsp;·&nbsp; {currentQuestions.length} pertanyaan
        </div>

        {/* DAFTAR SOAL — dibatasi 5 soal sesuai chunking */}
        {currentQuestions.map((q, idx) => {
          // Kalkulasi nomor urut agar tetap berlanjut (misal halaman ke-2 mulai dari no 6)
          const questionNumber = ((currentGroup.part - 1) * 5) + idx + 1;
          
          return (
            <div key={q.id} className="question-item">
              <h2>
                <span style={{ color: "#aaa", fontSize: "14px", marginRight: "8px" }}>
                  {questionNumber}.
                </span>
                {q.name}
              </h2>

              <div className="options-wrapper">
                <div className="label-left">Setuju</div>

                <div className="circles">
                  {[1, 2, 3, 4].map((i) => (
                    <div
                      key={i}
                      className={`circle ${selectedAnswers[q.id] === i ? "active" : ""}`}
                      onClick={() => handleSelectOption(q.id, i)}
                    />
                  ))}
                </div>

                <div className="label-right">
                  Tidak<br />Setuju
                </div>
              </div>
            </div>
          );
        })}

        {/* TOMBOL AKSI */}
        <div className="action-buttons">
          {currentPage > 0 && (
            <button className="prev-btn" onClick={handlePrevPage}>
              Kembali
            </button>
          )}

          <button
            className="next-btn"
            onClick={handleNextPage}
            disabled={
              !isCurrentPageComplete ||
              submitting ||
              (isOffline && currentPage === totalPages - 1)
            }
          >
            {getNextButtonLabel()}
          </button>
        </div>
      </div>

      {/* LOGO */}
      <div className="logo-bottom">Vimind</div>
    </div>
  );
}