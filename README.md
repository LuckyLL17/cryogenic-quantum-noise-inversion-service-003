# 低温量子器件实验数据校准与噪声谱反演服务

纯后端 Node.js + TypeScript 服务，不依赖数据库、Docker 或第三方运行时。服务从多通道 ADC/IQ 采样、实验时钟、仪器配置和校准版本中重建实验窗口，完成时钟同步、IQ 校准、窗口化、功率谱/互谱计算、相干性分析、噪声类型判别和 T1/T2/Ramsey 等衰减参数拟合。

## 运行

```bash
npm test
npm start
```

默认监听 `127.0.0.1:4387`。

## 主要接口

- `GET /health`
- `POST /v1/analyses`：提交分析任务，返回任务 ID
- `GET /v1/analyses/:id`：读取任务状态或结果
- `POST /v1/analyses/:id/cancel`：取消排队或运行中的任务
- `POST /v1/experiments/preview`：同步、校准并快速预览派生指标
- `POST /v1/experiments/drift-report`：对多次已有频谱做跨运行谱漂移比对

### 跨运行谱漂移报告

`POST /v1/experiments/drift-report` 接收 `{ runs: [{ label, sampleRateHz, spectrum, crossSpectrum?, coherence? }] }`（至少两次运行，标签唯一），先校验频率网格，再在所有运行共有的严格频点上计算：

- **基线**：低频漂移段（最低 10% 频点）和宽带白噪底段（最高 20% 频点）的均值功率、零功率频点和低频斜率（复用 `summarizeNoise` 语义）。
- **变化方向**：相邻运行基线单调上升/下降/平坦，并给出 dB 变化。
- **突变区间**：相邻运行间功率差 ≥ 6 dB（或零功率↔正功率）的连续频点段。
- **窄带峰与相关性**：复用主导频率、白噪底 8 倍峰判据和 0.7 相干阈值，判断峰位漂移、峰显著性变化和相关性跨阈值。
- **整体结论**：`stable` / `needs-review` / `incomparable`。

采样率不一致、网格间距不一致或共有正频频点不足两次时，返回 `incomparable` 且不计算任何频段统计；缺失频点只在共有频点上比较并降级为 `needs-review`，绝不插值或静默混算。空运行、重复标签、非单调/非均匀网格等结构性错误返回 422。报告只读输入谱，不修改原始数据，相同输入结果确定。

服务只使用内存任务存储；任务结果通过版本化的输入快照和校准版本引用保证可追溯。
