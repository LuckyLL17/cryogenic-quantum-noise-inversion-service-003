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
- `POST /v1/spectra/drift-report`：跨运行谱漂移报告，判断多次运行的噪声谱是否稳定

服务只使用内存任务存储；任务结果通过版本化的输入快照和校准版本引用保证可追溯。

## 跨运行谱漂移报告

`POST /v1/spectra/drift-report` 接收 `{ "runs": [{ "runLabel", "sampleRateHz", "spectrum", "coherence?" }], "jumpThresholdRatio?", "driftToleranceRatio?" }`，按给定顺序比较多次运行已有的频谱（`SpectrumBin[]`，与 `primarySpectrum` 同构）：

- 先校验频率网格：采样率、网格间距、网格对齐和重叠频段；任一不一致都判定 `not-comparable`，绝不静默混算。空运行、重复运行标签、非法频点、重复频点直接返回 422 错误。
- 在可比频段（所有运行共有的频点）内计算：逐频点基线（中位功率、最小/最大功率、离散比）、每个运行的带内积分功率、整体变化方向（`increasing` / `decreasing` / `flat`）、突变区间（相邻运行功率比超过 `jumpThresholdRatio` 的连续频点及其起止频率）。
- 每个运行复用现有 `summarizeNoise` 噪声分类语义（white / flicker / drift / periodic / correlated / insufficient-data）。
- 整体结论三选一：`stable`（稳定）、`needs-review`（需要复核：噪声类别变化、缺失频点、趋势漂移、突变区间或低分类置信度）、`not-comparable`（不可比较）。
- 报告为纯函数式计算：相同输入必得相同报告（含 `inputDigest` 便于追溯），且不修改输入谱。
