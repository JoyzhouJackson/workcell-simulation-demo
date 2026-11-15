"""Build the standalone APS briefing from business copy and the model routes."""

from html import escape
from pathlib import Path

from aps_briefing_content import CONTENT
from simpy_six_island_baseline import PUBLIC_KINDS, ROUTES

ROOT = Path(__file__).resolve().parent
PALETTE = {
    "S01": ("#2883a7", "#e4f2f8"), "S02": ("#137b72", "#e3f2ef"),
    "S03": ("#a14a24", "#fbede4"), "S04": ("#6b54a6", "#eee9f8"),
    "S05": ("#315d99", "#e7eef9"), "S06": ("#a14e79", "#f7e8f0"),
    "S07": ("#5c7539", "#edf2e5"),
}


def text(value):
    return escape(str(value))


def values(value):
    return value if isinstance(value, (list, tuple)) else [value]


def paragraphs(value, css=""):
    attribute = f' class="{css}"' if css else ""
    return "".join(f"<p{attribute}>{text(item)}</p>" for item in values(value))


def listing(value, ordered=False, css=""):
    tag = "ol" if ordered else "ul"
    attribute = f' class="{css}"' if css else ""
    return f"<{tag}{attribute}>" + "".join(f"<li>{text(item)}</li>" for item in values(value)) + f"</{tag}>"


def table(headers, rows, css=""):
    head = "".join(f'<th scope="col">{text(item)}</th>' for item in headers)
    body = "".join("<tr>" + "".join(f"<td>{cell}</td>" for cell in row) + "</tr>" for row in rows)
    return f'<div class="table-wrap"><table class="{css}"><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>'


def decision_link(key):
    return f'<a class="decision-tag" href="#decisions" data-go-decision="{text(key)}">{text(key)}</a>'


def render_problem():
    goal = CONTENT["goal"]
    result = paragraphs(CONTENT["problem"], "lead")
    result += "<h3>为什么需要 APS？</h3>" + paragraphs(CONTENT["why"])
    result += '<div class="objective">' + paragraphs(goal["formula"]) + "</div>"
    result += paragraphs(goal["explanation"])
    result += '<p class="note">' + text(goal["caveat"]) + "</p>"
    result += "<h3>先分清这些概念</h3>"
    result += table(["概念", "含义", "例子"], [
        [text(item["term"]), text(item["definition"]), text(item["example"])]
        for item in CONTENT["terms"]
    ])
    return result


def render_decisions():
    overview = table(["编号", "决策", "需要回答的业务问题"], [
        [decision_link(item["id"]), text(item["title"]), text(item["question"])]
        for item in CONTENT["decisions"]
    ], "overview-table")
    panels = []
    labels = (("parameters", "给定参数"), ("constraints", "必须满足的约束"), ("rule", "当前决策规则"))
    algorithms = (("solver", "求解器"), ("meta", "元启发式"), ("other", "其他算法"))
    for index, item in enumerate(CONTENT["decisions"]):
        key = item["id"]
        fields = "".join(f"<dt>{label}</dt><dd>{listing(item[field])}</dd>" for field, label in labels)
        hard = table(["候选方法", "替换当前规则时的具体难点"], [
            [text(label), listing(item["algorithms"][field])] for field, label in algorithms
        ], "algorithm-table")
        hidden = " hidden" if index else ""
        panels.append(f'<section class="decision-panel" data-decision="{key}" id="panel-{key}"{hidden}>'
                      f'<h3>{key} · {text(item["title"])}</h3>{paragraphs(item["question"])}'
                      f'<dl class="decision-fields">{fields}</dl><h4>如果改用算法，难点在哪里？</h4>{hard}'
                      f'<p class="boundary-note">{text(item["boundary"])}</p></section>')
    return overview, "".join(panels)


def render_resources():
    section = CONTENT["flexibility"]
    result = paragraphs(section["definition"], "lead") + paragraphs(section["example"])
    result += table(["资源", "作用", "柔性与选择空间", "当前建模范围"], [
        [text(item["resource"]), text(item["role"]), text(item["flexibility"]), text(item["status"])]
        for item in section["resources"]
    ], "resource-table")
    return result + listing(section["notes"])


def render_io():
    columns = []
    for key, heading in (("inputs", "输入：运行前需要给什么？"), ("outputs", "输出：安排与评价结果是什么？")):
        rows = []
        for item in CONTENT[key]:
            status = f'<p class="muted">{text(item["status"])}</p>' if item.get("status") else ""
            rows.append(f'<dt>{text(item["category"])}</dt><dd>{listing(item["items"])}{status}</dd>')
        columns.append(f'<section><h3>{heading}</h3><dl class="definition-list">{"".join(rows)}</dl></section>')
    return '<div class="io-columns">' + "".join(columns) + "</div>"


def render_constraints():
    return listing([f'{item["name"]}：{item["meaning"]}' for item in CONTENT["constraints"]], ordered=True, css="constraint-list")


def render_flow(key):
    steps = []
    for item in CONTENT["process"][key]:
        if steps:
            steps.append('<span class="process-arrow" aria-hidden="true">→</span>')
        links = " ".join(decision_link(decision) for decision in item["decisions"])
        if item["id"] == "branches":
            branches = "".join(f'<div class="process-step"><strong>部件 {symbol}</strong><p>按自身路线加工与搬运，完成后送到 S05 等待同单齐套。</p></div>' for symbol in ("A", "B", "C"))
            steps.append(f'<div class="process-parallel"><strong>{text(item["title"])}</strong>'
                         f'{paragraphs(item["body"])}<div class="process-branches">{branches}</div><p>{links}</p></div>')
        else:
            steps.append(f'<div class="process-step"><strong>{text(item["title"])}</strong>{paragraphs(item["body"])}<p>{links}</p></div>')
    result = '<div class="process-flow" aria-label="' + ("订单主流程" if key == "order_flow" else "单件加工与搬运循环") + '">' + "".join(steps) + "</div>"
    if key == "order_flow":
        result = paragraphs(CONTENT["process"]["introduction"]) + result
    else:
        result += listing(CONTENT["process"]["notes"])
    return result


def route_segment(visit):
    color, light = PALETTE[visit.island]
    return (f'<div class="route-segment" style="--route-color:{color};--route-light:{light}">'
            f'<div><strong>{text(visit.island)}</strong><span class="route-time">{visit.seconds} 秒</span></div>'
            f'<small>{text(visit.operations)}</small></div>')


def render_routes():
    legend = '<div class="route-legend">' + "".join(
        f'<span style="--route-color:{color}"><i aria-hidden="true"></i>{island}</span>'
        for island, (color, _) in PALETTE.items()
    ) + "</div>"
    result = '<p>下图采用模型基准路线及加工时间；场景修改以仿真页为准。每个节点代表连续同岛加工段，时间是整段总时间，搬运和等待另计。</p>' + legend
    result += '<p class="muted">各加工节点的排序与开工对应 ' + decision_link("D3") + '，工位分配对应 ' + decision_link("D4") + '；跨岛箭头对应 ' + decision_link("D5") + '。</p>'
    result += '<div class="route-start">订单到达 → S01 批处理与机外后处理 ' + decision_link("D1") + ' → 下游投放 ' + decision_link("D2") + "</div>"
    branches = []
    for kind in ("L", "R", "F"):
        visits = ROUTES[kind]
        nodes = '<div class="route-arrow" aria-hidden="true">↓</div>'.join(route_segment(visit) for visit in visits)
        branches.append(f'<div class="route-branch"><h3>部件 {PUBLIC_KINDS[kind]}<small>{len(visits)} 个加工段 · 纯加工 {sum(visit.seconds for visit in visits)} 秒</small></h3>{nodes}<span class="route-branch-tail">↓ 送往 S05 齐套</span></div>')
    result += '<div class="route-three">' + "".join(branches) + "</div>"
    result += '<div class="route-join">S05：同一订单的 A、B、C 三件全部到达 → ' + decision_link("D6") + ' 选择合装订单</div>'
    result += '<div class="route-assembly">' + '<div class="route-arrow" aria-hidden="true">→</div>'.join(route_segment(visit) for visit in ROUTES["M"]) + "</div>"
    result += '<div class="route-end">总成 P 最终工序完工 → 出库并记录完工时刻</div>'
    result += '<p class="note">支线途中经过 S05 时只执行该段加工，三条支线全部完成后才齐套合装。工艺回流是既定路线；需要防止的是资源相互占用、互相等待形成的死锁。</p>'
    return result


def render_capabilities():
    result = table(["状态", "内容", "说明"], [
        [text(item["status"]), text(item["title"]), text(item["body"])] for item in CONTENT["boundaries"]
    ], "capability-table")
    result += '<h3>方法参考</h3><p class="muted">算法难点是依据本模型结构的建模分析。以下官方资料解释基础方法，不代表本系统已接入这些求解器或已证明全线最优。</p><ul>'
    for item in CONTENT["references"]:
        result += f'<li><a href="{text(item["url"])}" target="_blank" rel="noopener noreferrer">{text(item["title"])}</a>：{text(item["note"])}</li>'
    return result + "</ul>"


def render_briefing():
    overview, panels = render_decisions()
    fields = {
        "__REPORT_BODY__": render_problem(), "__DECISION_OVERVIEW__": overview,
        "__DECISION_PANELS__": panels, "__RESOURCE_CONTENT__": render_resources(),
        "__IO_CONTENT__": render_io(), "__ASSUMPTION_CONTENT__": listing(CONTENT["assumptions"], ordered=True, css="assumption-list"),
        "__CONSTRAINT_CONTENT__": render_constraints(), "__MAIN_FLOW__": render_flow("order_flow"),
        "__PIECE_FLOW__": render_flow("piece_flow"), "__FULL_ROUTE__": render_routes(),
        "__CAPABILITY_CONTENT__": render_capabilities(),
    }
    page = (ROOT / "aps_briefing.template.html").read_text(encoding="utf-8")
    for marker, value in fields.items():
        if page.count(marker) != 1:
            raise ValueError(f"汇报模板标记 {marker} 须出现一次")
        page = page.replace(marker, value)
    return page


if __name__ == "__main__":
    output = ROOT / "docs/aps-briefing.html"
    output.write_text(render_briefing(), encoding="utf-8", newline="\n")
    print(output)
