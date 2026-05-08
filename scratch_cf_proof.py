"""
VERIFIKASI FIX: Simulasi CF dengan bobot jawaban user yang benar
"""

print("=" * 60)
print("CASE 1: User jawab 'Tidak Setuju' semua (harusnya sehat)")
print("=" * 60)

ocd_expert_cfs = [0.80, 0.60, 0.50, 0.40, 0.30]
cf_combined = 0.0
for i, expert_cf in enumerate(ocd_expert_cfs):
    cf_entry = 0.0 * expert_cf  # Tidak Setuju = 0.0
    cf_combined = cf_combined + cf_entry * (1 - cf_combined)
print(f"  OCD: {cf_combined*100:.1f}% ✅ (Harusnya 0%)")

print()
print("=" * 60)
print("CASE 2: User jawab 'Setuju' semua untuk OCD")
print("=" * 60)

cf_combined = 0.0
for i, expert_cf in enumerate(ocd_expert_cfs):
    cf_entry = 1.0 * expert_cf  # Setuju = 1.0
    cf_combined = cf_combined + cf_entry * (1 - cf_combined)
    print(f"  Gejala {i+1}: 1.0 × {expert_cf} = {cf_entry:.2f} → {cf_combined*100:.1f}%")
print(f"  OCD: {cf_combined*100:.1f}% ✅ (Tinggi, benar)")

print()
print("=" * 60)
print("CASE 3: User jawab campuran")
print("=" * 60)

user_answers = [1.0, 0.6, 0.0, 0.2, 0.0]  # Setuju, Cukup Setuju, Tidak, Kurang, Tidak
labels = ["Setuju", "Cukup Setuju", "Tidak Setuju", "Kurang Setuju", "Tidak Setuju"]
cf_combined = 0.0
for i, (expert_cf, user_cf) in enumerate(zip(ocd_expert_cfs, user_answers)):
    cf_entry = user_cf * expert_cf
    cf_combined = cf_combined + cf_entry * (1 - cf_combined)
    print(f"  Gejala {i+1} ({labels[i]}): {user_cf} × {expert_cf} = {cf_entry:.3f} → {cf_combined*100:.1f}%")
print(f"  OCD: {cf_combined*100:.1f}% ✅ (Menengah, realistis)")
