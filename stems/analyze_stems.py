import librosa
import numpy as np
import matplotlib.pyplot as plt
import os
import csv
from scipy.interpolate import interp1d

# 你的stem文件列表
stem_files = [
    "stems/stem_hi1.aif",
    "stems/stem_hi2.aif",
    "stems/stem_mid.aif",
    "stems/stem_low1.aif",
    "stems/stem_low2.aif"
]

# 建议采样率统一
TARGET_SR = 44100

def band_energy(S, freqs, f_low, f_high):
    idx = np.where((freqs >= f_low) & (freqs < f_high))[0]
    return np.mean(S[idx, :])


# 新：每帧能量输出
all_stem_energies = []  # 每个stem的每帧能量，列表元素为np.array
min_frames = None

for file in stem_files:
    y, sr = librosa.load(file, sr=TARGET_SR)
    print(f"{file} loaded: {y.shape}, {sr} Hz")

    hop_length = int(sr / 60)  # 每秒60帧
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop_length))
    frame_energies = np.mean(S, axis=0)
    # 归一化到0~1
    if np.max(frame_energies) > 0:
        frame_energies = (frame_energies - np.min(frame_energies)) / (np.max(frame_energies) - np.min(frame_energies))
    all_stem_energies.append(frame_energies)
    if min_frames is None or frame_energies.shape[0] < min_frames:
        min_frames = frame_energies.shape[0]

# 计算目标帧数（用真实长度，四舍五入）
audio_len_sec = len(y) / TARGET_SR
target_frames = int(np.round(audio_len_sec * 60))

# 对每个能量序列插值到 target_frames
interp_energies = []
for arr in all_stem_energies:
    old_idx = np.linspace(0, 1, num=arr.shape[0])
    new_idx = np.linspace(0, 1, num=target_frames)
    # 用线性插值，支持外推
    f = interp1d(old_idx, arr, kind='linear', fill_value='extrapolate')
    interp_arr = f(new_idx)
    # 超出范围的clip到0~1
    interp_arr = np.clip(interp_arr, 0, 1)
    interp_energies.append(interp_arr)

# 转置为每行一个时刻，列为每个stem
energy_matrix = np.stack(interp_energies, axis=1)  # shape: (target_frames, n_stems)

# 写入csv，表头为stem文件名
header = [os.path.basename(f) for f in stem_files]
with open("stems/stem_energy_timeseries.csv", "w", newline="") as f:
    writer = csv.writer(f)
    writer.writerow(header)
    for row in energy_matrix:
        writer.writerow([f"{v:.3f}" for v in row])