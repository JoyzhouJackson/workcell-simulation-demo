# Numbered Workcell Simulation

这是离散事件仿真演示。加工路线与分段工时采用已确认版本，工艺岛和部件名称使用符号。订单、资源容量、S01 批处理工时和运输时间沿用可修改的场景参数；布局使用虚构示意图。演示用于展示资源调度、缓冲约束与仿真界面。

- [整体仿真](https://joyzhoujackson.github.io/workcell-simulation-demo/)展示 S01–S07 七个编号工艺岛，部件 A、B、C 与总成 P 的流转、库位和订单完成情况。
- [APS 汇报说明](https://joyzhoujackson.github.io/workcell-simulation-demo/aps-briefing.html)解释业务问题、目标、六个决策的参数/约束/当前规则/算法难点、资源与柔性、输入输出、假设及流程。支持决策页签、流程跳转和打印。
- [批处理策略实验](https://joyzhoujackson.github.io/workcell-simulation-demo/scheduling/)使用同一组合成订单比较立即派工与限时等单。
- `simpy_six_island_baseline.py` 和 `six_island_engine.js` 分别提供 Python 与浏览器计算模型。
- `verify_seven_island.py` 对照两套模型的事件、搬运、逐单记录与资源上限。

## 运行与生成

安装 `scheduling/requirements.txt` 中的依赖后，可运行下面的命令。

```bash
python scheduling/run_arrival_experiment.py
python build_seven_island_demo.py
python verify_seven_island.py
```

整体演示由 `seven_island_demo.template.html`、计算引擎和通用布局素材生成到 `docs/index.html`。生成时传入 `--offline demo.html` 可同时得到单文件演示。网页参数使用公开演示专用的浏览器存储空间。

汇报说明由 `aps_briefing_content.py`、`aps_briefing.template.html` 和模型基准路线生成到 `docs/aps-briefing.html`，主构建会同步生成。离线单文件也内嵌说明页，点击入口即可打开，不依赖外部资源。

A、B、C、P 分别包含 14、12、3、4 个连续同岛加工段。首次升级时保留旧版订单、资源、搬运和规则设置，路线时间切换为本版基准，避免旧短路线的缓存覆盖新工时。后续编辑仍会自动保存。

## 示例数据

`scheduling/inputs/synthetic-orders.xlsx` 是从零生成的合成样例，包含示例订单和批处理时间表。数据输入目录只允许此文件纳入版本控制。私有数据可留在仓库外的本地目录。

S01 的共享缓冲按一套占一格。S05 合装前的同单部件可以按开关共用一格。其他阶段按单件或总成计格。所有资源容量都在仿真事件中校验。
