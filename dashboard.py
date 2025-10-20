import streamlit as st
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import seaborn as sns
from scipy.stats import norm
import statsmodels.formula.api as smf
import psycopg2  # 用于连接 NEON Postgres

st.title("Thesis Analysis Dashboard")

# NEON 连接设置：修正拼写错误为 "postgresql://" (原 "ppostgresql" 多了一个 'p')
# 替换为你的实际凭证
conn_string = "postgresql://neondb_owner:npg_nDuzkKxVIU79@ep-purple-recipe-adfg2vag-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"  # 添加 sslmode=require 如果需要
conn = psycopg2.connect(conn_string)

# 刷新按钮
if st.button('Refresh Dashboard'):
    st.experimental_rerun()

# 图1: Reaction Time Distribution (用 histplot 模拟 PDF 的块状 ██████)
st.subheader("1. (H1) Reaction Time Distribution")
st.write("RT = switchTime - audioTime")
st.write("Will M-B cause slower detection compared to M-A? #latency pattern no participant count 反应快靠左")

query_rt = """
SELECT l.delta_time * 1000 AS "RT", l.current_mode AS "Mode"
FROM thesis_logs l
JOIN thesis_sessions s ON l.session_id = s.session_id
WHERE s.valid = TRUE AND l.delta_time > 0 AND l.delta_time <= 2
"""
df_rt = pd.read_sql(query_rt, conn)

if df_rt.empty:
    st.warning("No valid data for Reaction Time Distribution.")
else:
    fig1, ax1 = plt.subplots(figsize=(10, 6))
    sns.histplot(data=df_rt, y='Mode', x='RT', hue='Mode', multiple='stack', bins=20, legend=False, ax=ax1)  # 水平栈块，如图片 ██████
    ax1.set_ylabel("Y probability density")
    ax1.set_xlabel("X (react time)")
    ax1.set_yticklabels(['A', 'B'])
    ax1.set_xticks([0, 500, 1000, 1500, 2000])
    ax1.set_xlim(0, 2000)
    st.pyplot(fig1)

# 图2: Hit Rate (水平条形图，如图片)
st.subheader("2. (H1/2) Hit Rate")
st.write("Hit rate = hits / total switches (Hit RT = 0-2 secs)")
st.write("Are switches under M-B detected less reliably than under M-A?")

query_hits = """
SELECT l.current_mode AS "Mode", COUNT(*) AS "hits"
FROM thesis_logs l
JOIN thesis_sessions s ON l.session_id = s.session_id
WHERE s.valid = TRUE AND l.delta_time >= 0 AND l.delta_time <= 2
GROUP BY l.current_mode
"""
hits_df = pd.read_sql(query_hits, conn)

query_total = """
SELECT COUNT(*) AS "total_switches"
FROM thesis_switches ts
JOIN thesis_sessions s ON ts.session_id = s.session_id
WHERE s.valid = TRUE
"""
total_df = pd.read_sql(query_total, conn)
total_switches = total_df['total_switches'].iloc[0] if not total_df.empty else 0

if total_switches > 0 and not hits_df.empty:
    num_modes = len(hits_df['Mode'].unique())
    hits_df['hit_rate'] = hits_df['hits'] / (total_switches / num_modes)
else:
    hits_df['hit_rate'] = 0

query_per_session = """
SELECT s.session_id AS "Session", l.current_mode AS "Mode", COUNT(CASE WHEN l.delta_time >= 0 AND l.delta_time <= 2 THEN 1 END) AS "hits",
 (SELECT COUNT(*) FROM thesis_switches ts WHERE ts.session_id = s.session_id) AS "session_total"
FROM thesis_logs l
JOIN thesis_sessions s ON l.session_id = s.session_id
WHERE s.valid = TRUE
GROUP BY s.session_id, l.current_mode
ORDER BY s.created_at
"""
per_session_df = pd.read_sql(query_per_session, conn)
if not per_session_df.empty:
    per_session_df['hit_rate'] = per_session_df['hits'] / (per_session_df['session_total'] / len(per_session_df['Mode'].unique()))

if hits_df.empty:
    st.warning("No valid data for Hit Rate.")
else:
    fig2, ax2 = plt.subplots(figsize=(10, 6))
    sns.barplot(data=hits_df, y='Mode', x='hit_rate', ax=ax2)  # 水平条，如图片
    if not per_session_df.empty:
        sns.lineplot(data=per_session_df, y='Mode', x='hit_rate', hue='Mode', ax=ax2.twinx())  # 水平线，移除 orient='h'
    ax2.set_ylabel("Y")
    ax2.set_xlabel("X (M-type)")
    st.pyplot(fig2)

# 图3: Signal Detection Metrics (散点图，如图片)
st.subheader("3. (H2) Signal Detection Metrics")
st.write("d' = Z(HitRate) - Z(FalseAlarmRate)")
st.write("Higher d' = better discrimination between real and false switches (clearer perception).")
st.write("Lower d' = poorer discrimination (more confusion between noise and signal).")
st.write("c = -0.5 * [Z(HitRate) + Z(FalseAlarmRate)]")
st.write("c = 0 = neutral = no bias")
st.write("c > 0 = conservative = participant presses only when sure.")
st.write("c < 0 = liberal = participant tends to press easily, even with risk of false alarms.")
st.write("Do participants adopt more conservative criterion (higher c) when reporting exits from M-B?")

query_sdt = """
SELECT l.current_mode AS "Mode", 
       COUNT(CASE WHEN l.delta_time >= 0 AND l.delta_time <= 2 THEN 1 END) AS "hits",
       COUNT(CASE WHEN l.delta_time < 0 OR l.delta_time > 2 THEN 1 END) AS "false_alarms",
       COUNT(*) AS "total_presses"
FROM thesis_logs l
JOIN thesis_sessions s ON l.session_id = s.session_id
WHERE s.valid = TRUE
GROUP BY l.current_mode
"""
sdt_df = pd.read_sql(query_sdt, conn)

if not sdt_df.empty:
    sdt_df['hit_rate'] = sdt_df['hits'] / sdt_df['total_presses']
    sdt_df['far'] = sdt_df['false_alarms'] / sdt_df['total_presses']
    sdt_df['hit_rate'] = np.clip(sdt_df['hit_rate'], 0.01, 0.99)
    sdt_df['far'] = np.clip(sdt_df['far'], 0.01, 0.99)
    sdt_df['d_prime'] = norm.ppf(sdt_df['hit_rate']) - norm.ppf(sdt_df['far'])
    sdt_df['c'] = -0.5 * (norm.ppf(sdt_df['hit_rate']) + norm.ppf(sdt_df['far']))
else:
    sdt_df = pd.DataFrame()

if sdt_df.empty:
    st.warning("No valid data for Signal Detection Metrics.")
else:
    fig3, ax3 = plt.subplots(figsize=(10, 6))
    sns.scatterplot(data=sdt_df, x='c', y='d_prime', hue='Mode', s=100, ax=ax3)  # 散点，如图片
    ax3.set_xlabel("X (Criterion c)")
    ax3.set_ylabel("Y (d' Sensitivity)")
    ax3.axvline(0, color='gray', linestyle='--')
    ax3.text(-1, max(sdt_df['d_prime']), 'Liberal-', ha='center')
    ax3.text(1, max(sdt_df['d_prime']), 'Conservative+', ha='center')
    st.pyplot(fig3)

# 图4: ΔE vs Hit Probability (散点图，如图片)
st.subheader("4. ΔE vs Hit Probability")
st.write("Hit Probability(ΔE) = hits in bin / total switches in bin")
st.write("logit(P(hit)) = β0 + β1*ΔE + β2*Mapping")
st.write("How instantaneous energy change (ΔE) influences detection probability across mappings?")

query_delta = """
SELECT ts.delta_e AS "ΔE", l.current_mode AS "Mapping",
       CASE WHEN l.delta_time >= 0 AND l.delta_time <= 2 THEN 1 ELSE 0 END AS "Hit"
FROM thesis_switches ts
LEFT JOIN thesis_logs l ON l.session_id = ts.session_id AND l.last_switch_time = ts.switch_time
JOIN thesis_sessions s ON ts.session_id = s.session_id
WHERE s.valid = TRUE
"""
df_delta = pd.read_sql(query_delta, conn)

if df_delta.empty:
    st.warning("No valid data for ΔE vs Hit Probability.")
else:
    df_delta['ΔE_bin'] = pd.cut(df_delta['ΔE'], bins=10)
    bin_df = df_delta.groupby('ΔE_bin')['Hit'].mean().reset_index()
    bin_df['ΔE_mid'] = bin_df['ΔE_bin'].apply(lambda x: x.mid if x is not None else np.nan)
    try:
        model = smf.logit('Hit ~ ΔE + Mapping', data=df_delta).fit(disp=0)
        df_delta['Pred'] = model.predict(df_delta)
        st.write("Logit Model Summary:")
        st.write(model.summary())
    except Exception as e:
        st.warning(f"Logit model failed: {e}")
    fig4, ax4 = plt.subplots(figsize=(10, 6))
    sns.scatterplot(data=bin_df, x='ΔE_mid', y='Hit', ax=ax4)  # 散点，如图片
    if 'Pred' in df_delta.columns:
        sns.lineplot(data=df_delta.sort_values('ΔE'), x='ΔE', y='Pred', hue='Mapping', ax=ax4)
    ax4.set_xlabel("X (ΔE Energy Change)")
    ax4.set_ylabel("Y (Hit Probability)")
    st.pyplot(fig4)

# 图5: Endogeneity control quasi-baseline (时间线图，如图片)
st.subheader("5. Endogeneity control quasi-baseline")
st.write("Does the baseline (30 s) segment show cleaner, unbiased differences between M-A and B?")

query_baseline = """
SELECT l.audio_time AS "Time", l.current_mode AS "Mode",
       CASE WHEN l.delta_time >= 0 AND l.delta_time <= 2 THEN 1 ELSE 0 END AS "Hit"
FROM thesis_logs l
JOIN thesis_sessions s ON l.session_id = s.session_id
WHERE s.valid = TRUE
"""
df_baseline = pd.read_sql(query_baseline, conn)

if df_baseline.empty:
    st.warning("No valid data for Baseline vs Adaptive.")
else:
    df_baseline_summary = df_baseline.groupby(['Time', 'Mode'])['Hit'].mean().reset_index(name='Hit Rate')
    fig5, ax5 = plt.subplots(figsize=(10, 6))
    sns.lineplot(data=df_baseline_summary, x='Time', y='Hit Rate', hue='Mode', ax=ax5)  # 时间线
    ax5.axvline(30, color='red', linestyle='--', label='Baseline End')
    ax5.set_xlabel("X (time in secs)")
    ax5.set_ylabel("Y")
    ax5.set_xlim(0, 180)
    ax5.legend()
    st.pyplot(fig5)

# 图6: Adaptive Difficulty and Spatial Remapping Logic (水平条形图，如图片)
st.subheader("6. Adaptive Difficulty and Spatial Remapping Logic")
st.write("Y (Hit rate or RT)")

query_adapt = """
SELECT CASE WHEN ts.mapping_id IS NULL OR ts.mapping_id = '' THEN 'No remap (fixed spatial layout)' ELSE 'With remap (rotated/mirrored bands)' END AS "Condition",
       AVG(CASE WHEN l.delta_time >= 0 AND l.delta_time <= 2 THEN 1 ELSE 0 END) AS "Hit Rate"
FROM thesis_switches ts
LEFT JOIN thesis_logs l ON l.session_id = ts.session_id AND l.last_switch_time = ts.switch_time
JOIN thesis_sessions s ON ts.session_id = s.session_id
WHERE s.valid = TRUE
GROUP BY "Condition"
"""
df_adapt = pd.read_sql(query_adapt, conn)

if df_adapt.empty:
    st.warning("No valid data for Adaptive Difficulty and Remapping.")
else:
    fig6, ax6 = plt.subplots(figsize=(10, 6))
    sns.barplot(data=df_adapt, y='Condition', x='Hit Rate', ax=ax6)  # 水平条，如图片
    ax6.set_xlabel("X (Condition)")
    ax6.set_ylabel("Y (Hit rate or RT)")
    st.pyplot(fig6)

# 表格 (匹配图片)
st.subheader("Adaptive scheduler conditions")
scheduler_data = pd.DataFrame({
    'Variable': ['recentHit', 'goodStreak', 'Otherwise', 'Mode hold time'],
    'Definition': ['Correct detections in the last four trials (RECENT_N = 4)', 'Consecutive perfect hits with RT ≤ 1.5 s', 'Criteria not met', 'Minimum duration before reevaluation'],
    'Threshold / Trigger': ['≥ 0.75', '≥ 2', '', '≥ 5 s'],
    'Effect': ['Promote “Hard”', 'Promote “Hard”', 'Maintain “Normal”', 'Prevent rapid oscillation']
})
st.dataframe(scheduler_data)

st.subheader("Mode comparison")
mode_data = pd.DataFrame({
    'Mode': ['Normal', 'Hard AE window'],
    'Switch interval': ['3 – 9 s', '2.6 – 6 s'],
    'Jitter': ['±10 %', '±10 %'],
    'Visual layout behavior': ['Fixed spatial layout', 'Occasional spatial remaps (r1, r2, mh, mv)'],
    'Energy-based': ['None', 'Chooses smoothest (–0.4 s to +0.6 s)']
})
st.dataframe(mode_data)

st.subheader("Spatial remapping operations")
remap_data = pd.DataFrame({
    'Label': ['r1', 'r2', 'mh', 'mv'],
    'Operation type': ['Rotate 1 slot clockwise', 'Rotate 2 slots clockwise', 'Mirror horizontal', 'Mirror vertical'],
    'Description': ['Shift all five visual bands one position', 'Shift all five bands two positions right.', 'Flip the entire layout vertically', 'Flip the layout horizontally']
})
st.dataframe(remap_data)

# 关闭连接
conn.close()