// The browser and the command line execute the same Python planner.
let runtimePromise;

async function getText(name) {
  const response = await fetch(new URL(name, import.meta.url));
  if (!response.ok) throw new Error(`读取 ${name} 失败（${response.status}）`);
  return response.text();
}

async function initialize() {
  const runtimeUrl = new URL("./runtime/", import.meta.url);
  const [{ loadPyodide }, planner, fixture, wheel] = await Promise.all([
    import(new URL("pyodide.mjs", runtimeUrl).href),
    getText("./planner.py"),
    getText("./fixture.json"),
    fetch(new URL("simpy-4.1.1-py3-none-any.whl", runtimeUrl)),
  ]);
  if (!wheel.ok) throw new Error("读取 SimPy 运行模块失败");
  const pyodide = await loadPyodide({ indexURL: runtimeUrl.href });
  pyodide.unpackArchive(await wheel.arrayBuffer(), "zip", { extractDir: "/home/pyodide/modules" });
  pyodide.FS.writeFile("/home/pyodide/modules/planner.py", planner);
  pyodide.runPython("import sys\nsys.path.insert(0, '/home/pyodide/modules')\nfrom planner import plan_json");
  pyodide.globals.set("case_fixture", fixture);
  return pyodide;
}

self.onmessage = async ({ data: { id, settings } }) => {
  try {
    if (!runtimePromise) {
      self.postMessage({ id, progress: "正在初始化 Python 与 SimPy…" });
      runtimePromise = initialize().catch(error => {
        runtimePromise = undefined;
        throw error;
      });
    }
    const pyodide = await runtimePromise;
    self.postMessage({ id, progress: "正在排加工、库位与 AGV，并校验完整计划…" });
    pyodide.globals.set("case_settings", JSON.stringify(settings));
    const json = pyodide.runPython("plan_json(case_settings, case_fixture)");
    self.postMessage({ id, plan: JSON.parse(json) });
  } catch (error) {
    const trace = String(error.message || error).trim();
    self.postMessage({ id, error: trace.split("\n").filter(Boolean).at(-1) || "排程失败" });
  }
};
