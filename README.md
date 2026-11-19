# Numbered Workcell Simulation

这是工艺岛与有限 AGV 的静态联合排程演示。工艺岛和部件使用编号，布局、路径和装卸数据用于示例。用户可修改输入后在浏览器中运行 Python/SimPy，联动查看实时 3D 车间、甘特图、缓冲占用与逐单完工。

- [静态协同排程](https://joyzhoujackson.github.io/workcell-simulation-demo/)以一批已知订单为输入，区分实体岛、工位、库位、装卸口和车辆；首轮 10 单，普通岛 50 格，S04 每岛 999 格，车队初始停靠 S01 旁。
- [原规则仿真](https://joyzhoujackson.github.io/workcell-simulation-demo/classic.html)保留旧版参数和回放。
- [APS 汇报说明](https://joyzhoujackson.github.io/workcell-simulation-demo/aps-briefing.html)解释业务问题、目标、六个决策的参数/约束/当前规则/算法难点、资源与柔性、输入输出、假设及流程。支持决策页签、流程跳转和打印。
- [批处理策略实验](https://joyzhoujackson.github.io/workcell-simulation-demo/scheduling/)使用同一组合成订单比较立即派工与限时等单。
- `simpy_six_island_baseline.py` 和 `six_island_engine.js` 分别提供 Python 与浏览器计算模型。
- `verify_seven_island.py` 对照两套模型的事件、搬运、逐单记录与资源上限。
- `joint/planner.py` 生成并校验联合排程，页面通过 Worker 中的 Pyodide/SimPy 运行同一实现。回放、滚动条和甘特图的竖线读取同一个秒级时钟。

## 运行与生成

安装 `scheduling/requirements.txt` 中的依赖后，可运行下面的命令。

```bash
python scheduling/run_arrival_experiment.py
python build_joint_demo.py --classic
python verify_seven_island.py
python joint/planner.py --output plan.json
python -m http.server 8771 --directory docs
```

联合排程入口是 `docs/index.html`，浏览器计算使用随站点发布的 Pyodide 0.28.3、SimPy 4.1.1 和 Three.js 0.179.1。可通过本地 HTTP 服务运行。原规则版本由 `build_seven_island_demo.py` 生成到 `docs/classic.html`，传入 `--offline demo.html` 可生成旧版的单文件演示。

汇报说明由 `aps_briefing_content.py`、`aps_briefing.template.html` 和模型基准路线生成到 `docs/aps-briefing.html`，主构建会同步生成。离线单文件也内嵌说明页，点击入口即可打开，不依赖外部资源。

A、B、C、P 分别包含 14、12、3、4 个连续同岛加工段。首次升级时保留旧版订单、资源、搬运和规则设置，路线时间切换为本版基准，避免旧短路线的缓存覆盖新工时。后续编辑仍会自动保存。

## 示例数据

`scheduling/inputs/synthetic-orders.xlsx` 是从零生成的合成样例，包含示例订单和批处理时间表。数据输入目录只允许此文件纳入版本控制。私有数据可留在仓库外的本地目录。

S01 的共享缓冲按一套占一格。S05 合装前的同单部件共用一格。其他阶段按单件或总成计格。AGV 每趟只在一对实体岛间运输 1–5 件，能够等待同流向、已在加工且预计往返时间内就绪的零件。候选方案在全批完工后才通过验证，拥堵场景尝试错峰投放。静态计划采用可行方案比较，结果可能受调度规则限制；后续四小时滚动重排、避碰与充电属于扩展。交通诊断列出近时段争用，当前排程没有施加道路冲突约束。
