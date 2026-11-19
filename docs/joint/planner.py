"""Deterministic finite-buffer workcell and AGV scheduling, executed with SimPy.

Run: python joint/planner.py --output plan.json
Settings and the public route/printing fixture can also be supplied as JSON.
"""

import argparse
from collections import defaultdict
from dataclasses import dataclass, field
import heapq
from itertools import pairwise
import json
from math import ceil, dist, isfinite
from pathlib import Path

import simpy


DEFAULTS = dict(orders=10, glueCount=2, restCount=2, buffer=50, restBuffer=999,
                agvs=0, maxLoad=5, speed=1, loadSeconds=5, unloadSeconds=5,
                combine=True, printMachines=3, prepMinutes=4, postMinutes=7,
                switchMinutes=3, routeTimes={}, printTimes={})
BOUNDS = dict(orders=(1, 100), glueCount=(1, 4), restCount=(1, 4),
              buffer=(1, 9999), restBuffer=(1, 9999), agvs=(0, 40),
              maxLoad=(1, 5), speed=(0.1, 5), loadSeconds=(0, 600),
              unloadSeconds=(0, 600), printMachines=(1, 12),
              prepMinutes=(0, 180), postMinutes=(0, 180), switchMinutes=(0, 180))
PARTS = ("A", "B", "C")
ASSEMBLY = "S05"
PRINT = "S01"
REST = "S04"


def checked_number(value, label, low, high, integer=True):
    if (type(value) not in (int, float) or not isfinite(value) or
            not low <= value <= high or (integer and int(value) != value)):
        raise ValueError(f"{label} 的值须在 {low}–{high} 范围内" + ("，且为整数" if integer else ""))
    return int(value) if integer else float(value)


def checked_settings(overrides, fixture):
    config = DEFAULTS | overrides
    result = {key: checked_number(config[key], key, *limits, key != "speed")
              for key, limits in BOUNDS.items()}
    if type(config["combine"]) is not bool:
        raise ValueError("凑批规则须设为开启或关闭")
    result["combine"] = config["combine"]
    valid_keys = {
        "routeTimes": {op["label"] for route in fixture["routes"].values() for op in route},
        "printTimes": set(fixture["printTimes"]),
    }
    for key in valid_keys:
        values = config[key]
        if not isinstance(values, dict) or set(values) - valid_keys[key]:
            raise ValueError(f"{key} 包含未知工序或批量")
        result[key] = {name: checked_number(value, name, 1, 86400 if key == "routeTimes" else 1440)
                       for name, value in values.items()}
    return result


def make_layout(config):
    nodes, edges = {}, []
    # Synthetic two-sided layout. Station ramps meet a central two-way aisle.
    positions = [("S01", 9, -11), ("S02-1", 21, -11), ("S03", 33, -11),
                 ("S02-2", 45, -11), ("S04-1", 9, 11), ("S05", 21, 11),
                 ("S06", 33, 11), ("S07", 45, 11), ("S04-2", 57, 11),
                 ("S02-3", 57, -11), ("S02-4", 69, -11),
                 ("S04-3", 69, 11), ("S04-4", 81, 11)]
    nodes["PARK"] = dict(x=0, y=0, label="停车区", type="parking", buffer=0, workstations=0)
    for name, x, y in positions:
        island_type, _, copy = name.partition("-")
        if copy and int(copy) > config[{"S02": "glueCount", REST: "restCount"}[island_type]]:
            continue
        count = config["printMachines"] if name == PRINT else int(island_type != REST)
        capacity = config["restBuffer" if island_type == REST else "buffer"]
        nodes[name] = dict(x=x, y=y, label=name, type=island_type,
                           buffer=capacity, workstations=count)
        junction = f"J{x}"
        nodes.setdefault(junction, dict(x=x, y=0, label="", type="road", buffer=0, workstations=0))
        edges.append([junction, name])
    junctions = ["PARK"] + sorted((n for n in nodes if n.startswith("J")),
                                  key=lambda n: nodes[n]["x"])
    edges.extend([a, b] for a, b in pairwise(junctions))
    return dict(nodes=nodes, edges=edges)


class Paths:
    def __init__(self, layout, speed):
        self.speed = speed
        self.points = {n: (p["x"], p["y"]) for n, p in layout["nodes"].items()}
        self.graph = defaultdict(list)
        for a, b in layout["edges"]:
            length = dist(self.points[a], self.points[b])
            self.graph[a].append((b, length))
            self.graph[b].append((a, length))
        self.cache = {}

    def find(self, origin, destination):
        key = origin, destination
        if key in self.cache:
            return self.cache[key]
        visited = set()
        queue = [(0, (origin,))]
        while queue:
            length, path = heapq.heappop(queue)
            node = path[-1]
            if node in visited:
                continue
            if node == destination:
                result = length, ceil(length / self.speed), path
                self.cache[key] = result
                return result
            visited.add(node)
            for neighbor, edge in self.graph[node]:
                if neighbor not in visited:
                    heapq.heappush(queue, (length + edge, (*path, neighbor)))
        raise ValueError(f"{origin} 到 {destination} 没有可用路径")

    def coordinates(self, path):
        return [self.points[node] for node in path]


@dataclass(eq=False)
class Part:
    order: int
    kind: str
    step: int = 0
    ready: int = 0
    allocated: bool = False

    def label(self):
        return f"{self.order:03d}·{self.kind}"


@dataclass
class Cell:
    name: str
    kind: str
    capacity: int
    buffered: list = field(default_factory=list)
    inbound: list = field(default_factory=list)
    working: list = field(default_factory=list)
    print_sets: set = field(default_factory=set)
    dock: list = field(default_factory=list)
    peak: int = 0


@dataclass
class Vehicle:
    name: str
    location: str = "PARK"
    busy: bool = False


class Schedule:
    def __init__(self, config, routes, print_times, layout, batch_limit, wip_limit, policy):
        self.config = config
        self.routes = routes
        self.print_times = print_times
        self.layout = layout
        self.batch_limit = batch_limit
        self.wip_limit = wip_limit
        self.policy = policy
        self.env = simpy.Environment()
        self.cells = {name: Cell(name, node["type"], node["buffer"])
                      for name, node in layout["nodes"].items() if node["buffer"]}
        self.choices = defaultdict(list)
        for name, cell in self.cells.items():
            self.choices[cell.kind].append(name)
        self.paths = Paths(layout, config["speed"])
        self.vehicles = [Vehicle(f"AGV-{i+1:02d}") for i in range(config["agvs"] or len(self.cells))]
        self.print_next = [0] * config["printMachines"]
        self.printing = set()
        self.releases = []
        self.waiting_orders = list(range(1, config["orders"] + 1))
        self.released = 0
        self.completed = {}
        self.operations = []
        self.trips = []
        self.frames = []
        self.held = {}
        self.used_wait = set()
        self.waited_trips = 0
        self.peak_wip = 0
        self.assembly_visits = {part: max((i for i, op in enumerate(routes[part])
                                           if op["island"] == ASSEMBLY), default=-1)
                                for part in PARTS}
        self.branch_parts = {}

    @property
    def now(self):
        return int(self.env.now)

    def defer(self, at, fn=None, *args):
        def execute():
            yield self.env.timeout(at - self.env.now)
            if fn is not None:
                fn(*args)
        self.env.process(execute())

    def operation(self, start, end, cell, resource, kind, label, order=None, part=None, **extra):
        self.operations.append(dict(start=start, end=end, island=cell, resource=resource,
                                    kind=kind, label=label, order=order, part=part, **extra))

    def next_type(self, part):
        route = self.routes[part.kind]
        return route[part.step]["island"] if part.step < len(route) else ASSEMBLY

    def waiting_for_kit(self, part):
        return part.kind in PARTS and part.step == len(self.routes[part.kind])

    def slot(self, island, part):
        if island == PRINT or (island == ASSEMBLY and self.waiting_for_kit(part)):
            return (part.order, "set")
        return (part.order, part.kind)

    def slots(self, cell):
        used = {self.slot(cell.name, part) for part in cell.buffered}
        used.update((order, "set") for order in cell.print_sets)
        reserved = {self.slot(cell.name, part) for part in cell.inbound}
        reserved.update(self.slot(cell.name, part) for part, _ in cell.working
                        if part.kind != "P" or part.step < len(self.routes["P"]) - 1)
        return used, reserved - used

    def start_printing(self):
        if not self.waiting_orders:
            return False
        cell = self.cells[PRINT]
        used, reserved = self.slots(cell)
        remaining = min(len(self.waiting_orders), self.batch_limit, cell.capacity - len(used | reserved),
                        self.wip_limit - self.released + len(self.completed))
        size = max((n for n in self.print_times if n <= remaining), default=0)
        prep, post, switch = (60 * self.config[k] for k in ("prepMinutes", "postMinutes", "switchMinutes"))
        allowed = [i for i, nxt in enumerate(self.print_next) if nxt <= self.now + prep]
        if not size or not allowed:
            return False
        machine = min(allowed, key=lambda i: (self.print_next[i], i))
        previous = self.print_next[machine] - switch
        start = self.now + prep
        end = start + self.print_times[size]
        done = end + post
        ids = tuple(self.waiting_orders[:size])
        del self.waiting_orders[:size]
        self.released += size
        self.peak_wip = max(self.peak_wip, self.released - len(self.completed))
        cell.print_sets.update(ids)
        label = f"#{ids[0]:03d}" if size == 1 else f"#{ids[0]:03d}–{ids[-1]:03d}"
        resource = f"{PRINT}·设备 {machine + 1}"
        if previous > 0 and switch:
            self.operation(previous, previous + switch, PRINT, resource, "setup", f"切换 {label}")
        if prep:
            self.operation(self.now, start, PRINT, f"{PRINT}·准备", "prep", f"准备 {label}")
        self.operation(start, end, PRINT, resource, "print", f"批处理 {label}", orders=ids)
        if post:
            self.operation(end, done, PRINT, f"{PRINT}·后处理", "post", f"后处理 {label}")
        self.print_next[machine] = end + switch
        self.defer(start, self.printing.add, machine)
        self.defer(end, self.printing.discard, machine)
        self.defer(done, self.release_parts, ids)
        self.defer(max(end, end + switch - prep))
        self.releases.append((ids, done))
        return True

    def release_parts(self, ids):
        cell = self.cells[PRINT]
        for order in ids:
            cell.print_sets.remove(order)
            for kind in PARTS:
                part = Part(order, kind, ready=self.now)
                self.branch_parts[order, kind] = part
                cell.buffered.append(part)

    def priority(self, part):
        return (part.order, part.ready, part.kind)

    def try_work(self, cell):
        if cell.kind == PRINT or (cell.kind != REST and cell.working):
            return False
        candidates, kits = [], defaultdict(list)
        for part in cell.buffered:
            if part.allocated or self.next_type(part) != cell.kind:
                continue
            if self.waiting_for_kit(part):
                kits[part.order].append(part)
            else:
                candidates.append((self.priority(part), part, (part,)))
        for order, members in kits.items():
            if len(members) == 3:
                ready = max(p.ready for p in members)
                assembly = Part(order, "P", ready=ready)
                candidates.append((self.priority(assembly), assembly, members))
        if not candidates:
            return False
        _, part, consumed = min(candidates, key=lambda c: c[0])
        op = self.routes[part.kind][part.step]
        for item in consumed:
            cell.buffered.remove(item)
        end = self.now + op["duration"]
        cell.working.append((part, end))
        kind = ("rest" if cell.kind == REST else "assembly" if part.kind == "P" and part.step == 0
                else "process")
        self.operation(self.now, end, cell.name, cell.name, kind,
                       f"{op['label']} · {part.label()}", part.order, part.kind, code=op["label"])
        self.defer(end, self.finish_work, cell, part, end)
        return True

    def finish_work(self, cell, part, end):
        cell.working.remove((part, end))
        part.step += 1
        part.ready = self.now
        if part.kind == "P" and part.step == len(self.routes["P"]):
            self.completed[part.order] = self.now
        else:
            cell.buffered.append(part)

    def eligible_at(self, cell, part, slots):
        # Preserve one shared kit location for each unfinished order. Avoid admitting
        # a kit into the last slot while its own branches still need an earlier visit.
        if cell.name != ASSEMBLY or not self.waiting_for_kit(part):
            return True
        if self.slot(cell.name, part) in slots:
            return True
        if len(slots) < cell.capacity - 1:
            return True
        return all(self.branch_parts[part.order, kind].step > self.assembly_visits[kind] for kind in PARTS)

    def fit(self, cell, ordered_parts):
        used, reserved = self.slots(cell)
        slots = used | reserved
        batch = []
        for part in ordered_parts:
            slot = self.slot(cell.name, part)
            if (slot in slots or len(slots) < cell.capacity) and self.eligible_at(cell, part, slots):
                batch.append(part)
                slots.add(slot)
                if len(batch) == self.config["maxLoad"]:
                    break
        return batch

    def groups(self):
        groups = defaultdict(list)
        for source in self.cells.values():
            for part in source.buffered:
                if part.allocated or self.next_type(part) == source.kind:
                    continue
                for destination in self.choices[self.next_type(part)]:
                    groups[source.name, destination].append(part)
        return groups

    @staticmethod
    def dock_time(cell, earliest, duration):
        if not duration:
            return earliest
        for start, end, _ in cell.dock:
            if earliest + duration <= start:
                break
            if earliest < end:
                earliest = end
        return earliest

    def offer(self, vehicle, source, target, count):
        _, empty, empty_path = self.paths.find(vehicle.location, source.name)
        _, loaded, loaded_path = self.paths.find(source.name, target.name)
        empty_arrival = self.now + empty
        load = count * self.config["loadSeconds"]
        unload = count * self.config["unloadSeconds"]
        pickup = self.dock_time(source, empty_arrival, load)
        leave = pickup + load
        arrival = leave + loaded
        unload_at = self.dock_time(target, arrival, unload)
        return dict(start=self.now, emptyArrival=empty_arrival, pickup=pickup, loadEnd=leave,
                    arrival=arrival, unloadStart=unload_at, end=unload_at + unload,
                    emptyPath=self.paths.coordinates(empty_path), loadedPath=self.paths.coordinates(loaded_path))

    def join_time(self, source, target, batch, cutoff):
        joins = []
        if source.name == PRINT and target.kind == self.routes["A"][0]["island"]:
            for ids, done in self.releases:
                if self.now < done <= cutoff:
                    joins.extend((done, Part(order, kind)) for order in ids for kind in PARTS)
        for part, end in source.working:
            if self.now < end <= cutoff:
                next_part = Part(part.order, part.kind, part.step + 1, end)
                if (part.kind != "P" or next_part.step < len(self.routes["P"])) and (
                        self.next_type(next_part) == target.kind):
                    joins.append((end, next_part))
        for ready, part in sorted(joins, key=lambda j: (j[0], self.priority(j[1]))):
            # S01 future parts have no previous work before their ready event.
            if len(self.fit(target, [*batch, part])) > len(batch):
                return ready
        return None

    def try_dispatch(self):
        idle = [vehicle for vehicle in self.vehicles if not vehicle.busy]
        if not idle:
            return False
        options = []
        for pair, parts in self.groups().items():
            source, target = (self.cells[name] for name in pair)
            batch = self.fit(target, sorted(parts, key=self.priority))
            if not batch:
                continue
            vehicle, times = min(((v, self.offer(v, source, target, len(batch))) for v in idle),
                                 key=lambda option: (option[1]["end"], option[1]["pickup"], option[0].name))
            ancestor = batch[0]
            anchor = (pair, ancestor.order, ancestor.kind, ancestor.step)
            if len(batch) < self.config["maxLoad"] and self.config["combine"]:
                held = self.held.get(anchor, 0)
                if self.now < held:
                    continue
                if anchor not in self.used_wait:
                    cutoff = times["end"] + self.paths.find(target.name, source.name)[1]
                    ready = self.join_time(source, target, batch, cutoff)
                    if ready is not None:
                        self.used_wait.add(anchor)
                        self.held[anchor] = ready
                        self.defer(ready)
                        continue
            operation_work = sum(self.routes[p.kind][p.step]["duration"] for p in target.buffered
                                 if not p.allocated and not self.waiting_for_kit(p)
                                 and self.next_type(p) == target.kind) if target.kind != REST else 0
            next_free = max((end for _, end in target.working), default=self.now) if target.kind != REST else self.now
            next_start = max(times["end"], next_free) + operation_work
            options.append(((ancestor.order, next_start, -len(batch), times["end"], pair),
                            vehicle, source, target, batch, times, anchor))
        if not options:
            return False
        _, vehicle, source, target, batch, times, anchor = min(options, key=lambda option: option[0])
        self.dispatch(vehicle, source, target, batch, times, anchor)
        return True

    def dispatch(self, vehicle, source, target, batch, times, anchor):
        vehicle.busy = True
        for part in batch:
            part.allocated = True
            target.inbound.append(part)
        waited = anchor in self.held and self.held.pop(anchor) <= self.now
        self.waited_trips += int(waited)
        trip_id = f"T{len(self.trips) + 1:04d}"
        for cell, a, b in [(source, times["pickup"], times["loadEnd"]),
                           (target, times["unloadStart"], times["end"])]:
            if a < b:
                cell.dock.append((a, b, trip_id))
                cell.dock.sort()
        self.trips.append(dict(id=trip_id, vehicle=vehicle.name, source=source.name, target=target.name,
                               parts=[dict(order=p.order, part=p.kind) for p in batch], waited=waited, **times))
        self.defer(times["loadEnd"], self.pickup, source, batch)
        self.defer(times["end"], self.deliver, vehicle, target, batch)

    def pickup(self, source, batch):
        for part in batch:
            source.buffered.remove(part)

    def deliver(self, vehicle, target, batch):
        vehicle.location = target.name
        vehicle.busy = False
        for part in batch:
            target.inbound.remove(part)
            part.ready = self.now
            part.allocated = False
            target.buffered.append(part)

    def settle(self):
        for cell in self.cells.values():
            cell.dock[:] = [event for event in cell.dock if event[1] > self.now]
        while self.start_printing():
            pass
        for cell in self.cells.values():
            while self.try_work(cell):
                pass
        while self.try_dispatch():
            pass

    def capture(self):
        islands = {}
        for name, cell in self.cells.items():
            used, reserved = self.slots(cell)
            cell.peak = max(cell.peak, len(used) + len(reserved))
            if cell.peak > cell.capacity:
                raise RuntimeError(f"{name} 缓冲位溢出")
            busy = len(self.printing) if name == PRINT else len(cell.working)
            if cell.kind != REST and busy > self.layout["nodes"][name]["workstations"]:
                raise RuntimeError(f"{name} 工位重复占用")
            islands[name] = dict(used=len(used), reserved=len(reserved), capacity=cell.capacity, busy=busy)
        frame = dict(time=self.now, islands=islands, completed=len(self.completed))
        if self.frames and self.frames[-1]["time"] == self.now:
            self.frames[-1] = frame
        elif not self.frames or any(self.frames[-1][key] != frame[key] for key in ("islands", "completed")):
            self.frames.append(frame)

    def blockers(self):
        if len(self.completed) == self.config["orders"]:
            return []
        messages = []
        for (source, destination), parts in sorted(self.groups().items()):
            if not self.fit(self.cells[destination], sorted(parts, key=self.priority)):
                messages.append(f"{source} → {destination}：{len(parts)} 件等待目的位或齐套位")
        cell = self.cells[ASSEMBLY]
        kits = defaultdict(list)
        for part in cell.buffered:
            if self.waiting_for_kit(part):
                kits[part.order].append(part.kind)
        for order, kinds in sorted(kits.items()):
            missing = ", ".join(kind for kind in PARTS if kind not in kinds)
            if missing:
                messages.append(f"{ASSEMBLY} 订单 {order:03d} 齐套等待：{missing}")
        if self.waiting_orders:
            messages.append(f"{PRINT} 尚有 {len(self.waiting_orders)} 单等待投放")
        return messages or ["未找到下一步可执行的资源安排。"]

    def run(self):
        self.settle()
        self.capture()
        while self.env.peek() != float("inf") and len(self.completed) < self.config["orders"]:
            next_time = self.env.peek()
            while self.env.peek() == next_time:
                self.env.step()
            self.settle()
            self.capture()
        return self

    def score(self):
        return (-len(self.completed), sum(self.completed.values()), len(self.trips), self.now)

    def export(self, attempts):
        duration = max([self.now] + [op["end"] for op in self.operations] + [t["end"] for t in self.trips])
        result = dict(settings=self.config, layout=self.layout, vehicles=[v.name for v in self.vehicles],
                      operations=self.operations, trips=self.trips, frames=self.frames, routes=self.routes,
                      orders=[dict(id=order, arrival=0, completed=self.completed.get(order),
                                   flow=self.completed.get(order))
                              for order in range(1, self.config["orders"] + 1)],
                      duration=duration, blocked=self.blockers(), printTimes={str(n): sec // 60
                                                                            for n, sec in self.print_times.items()})
        complete = len(self.completed) == self.config["orders"]
        audit_plan(result, require_complete=complete)
        conflict_count, conflicts = traffic_scan(self.trips)
        result["trafficConflicts"] = conflicts
        result["stats"] = dict(completed=len(self.completed),
                               averageFlow=sum(self.completed.values()) / len(self.completed) if complete else None,
                               trips=len(self.trips),
                               emptySeconds=sum(t["emptyArrival"] - t["start"] for t in self.trips),
                               loadedSeconds=sum(t["arrival"] - t["loadEnd"] for t in self.trips),
                               waitedTrips=self.waited_trips, trafficConflicts=conflict_count,
                               validation=complete, policy=self.policy, alternatives=attempts,
                               peakWip=self.peak_wip, peakBuffers={n: c.peak for n, c in self.cells.items()})
        return result


def audit_plan(plan, require_complete):
    """Check half-open equipment, vehicle and dock intervals and every job handoff."""
    exclusive = defaultdict(list)
    by_part = defaultdict(list)
    delivered = defaultdict(list)
    printed = {}
    post_end = {}
    for op in plan["operations"]:
        if op["kind"] in ("print", "setup", "process", "assembly"):
            exclusive[op["resource"]].append((op["start"], op["end"]))
        if op["order"] is not None:
            by_part[op["order"], op["part"]].append(op)
        if op["kind"] == "print":
            for order in op["orders"]:
                if order in printed:
                    raise RuntimeError(f"订单 {order} 重复启动批处理")
                printed[order] = op["end"] + plan["settings"]["postMinutes"] * 60
    vehicle_ends = {vehicle: (0, "PARK") for vehicle in plan["vehicles"]}
    nodes = plan["layout"]["nodes"]
    for trip in plan["trips"]:
        times = [trip[key] for key in ("start", "emptyArrival", "pickup", "loadEnd", "arrival", "unloadStart", "end")]
        if times != sorted(times) or not 1 <= len(trip["parts"]) <= plan["settings"]["maxLoad"]:
            raise RuntimeError("车辆时序或载量超限")
        previous_end, previous_position = vehicle_ends[trip["vehicle"]]
        for path_key, start, end in [("emptyPath", previous_position, trip["source"]),
                                     ("loadedPath", trip["source"], trip["target"])]:
            path = trip[path_key]
            if any(tuple(point) != (nodes[node]["x"], nodes[node]["y"])
                   for point, node in [(path[0], start), (path[-1], end)]):
                raise RuntimeError(f"{trip['vehicle']} 的连续车次位置不一致")
        if previous_end > trip["start"] or trip["source"] == trip["target"]:
            raise RuntimeError(f"{trip['vehicle']} 的车次时间或起讫点不一致")
        vehicle_ends[trip["vehicle"]] = (trip["end"], trip["target"])
        exclusive[trip["vehicle"]].append((trip["start"], trip["end"]))
        exclusive["dock:" + trip["source"]].append((trip["pickup"], trip["loadEnd"]))
        exclusive["dock:" + trip["target"]].append((trip["unloadStart"], trip["end"]))
        for item in trip["parts"]:
            delivered[item["order"], item["part"]].append(trip)
    for resource, intervals in exclusive.items():
        for previous, following in pairwise(sorted((a, b) for a, b in intervals if b > a)):
            if previous[1] > following[0]:
                raise RuntimeError(f"{resource} 的占用时段重叠")
    for frame in plan["frames"]:
        for name, data in frame["islands"].items():
            if not 0 <= data["used"] + data["reserved"] <= data["capacity"]:
                raise RuntimeError(f"{name} 仓位不满足容量")
    if require_complete and any(row["used"] or row["reserved"] or row["busy"]
                                for row in plan["frames"][-1]["islands"].values()):
        raise RuntimeError("出库完毕后仍有工件占用工位或缓冲区")
    for row in plan["orders"]:
        order = row["id"]
        for kind in (*PARTS, "P"):
            work = sorted(by_part[order, kind], key=lambda op: op["start"])
            route = plan["routes"][kind]
            if (require_complete and len(work) != len(route)) or any(
                    op["code"] != step["label"] or op["end"] - op["start"] != step["duration"] or
                    plan["layout"]["nodes"][op["island"]]["type"] != step["island"]
                    for op, step in zip(work, route)):
                raise RuntimeError(f"订单 {order}·{kind} 工序与路线不符")
            prior_end = printed.get(order, 0)
            prior_cell = PRINT if kind != "P" else ASSEMBLY
            if kind == "P" and work:
                for member in PARTS:
                    available = post_end.get((order, member))
                    if available is None or work[0]["start"] < available:
                        raise RuntimeError(f"订单 {order} 未齐套即合装")
            for op in work:
                if prior_end > op["start"]:
                    raise RuntimeError(f"订单 {order}·{kind} 前后加工重叠")
                if prior_cell != op["island"] and not any(
                        t["source"] == prior_cell and t["target"] == op["island"] and
                        prior_end <= t["pickup"] <= t["end"] <= op["start"]
                        for t in delivered[order, kind]):
                    raise RuntimeError(f"订单 {order}·{kind} 跨岛加工缺少有效搬运")
                prior_cell, prior_end = op["island"], op["end"]
            if kind in PARTS and len(work) == len(route):
                arrival = next((t["end"] for t in delivered[order, kind]
                                if t["source"] == prior_cell and t["target"] == ASSEMBLY
                                and t["pickup"] >= prior_end), None)
                post_end[order, kind] = prior_end if prior_cell == ASSEMBLY else arrival
            if kind == "P" and row["completed"] is not None:
                if len(work) != len(route) or work[-1]["end"] != row["completed"]:
                    raise RuntimeError(f"订单 {order} 完工记录与最后工序不一致")


def traffic_scan(trips):
    """Flag overlapping narrow approaches and close arrivals at junctions.

    The spine allows two-way traffic. Its co-directional headway is estimated
    at one second. This diagnostic does not change the dispatch schedule.
    """
    reservations = defaultdict(list)
    for trip in trips:
        for start, end, path in [(trip["start"], trip["emptyArrival"], trip["emptyPath"]),
                                 (trip["loadEnd"], trip["arrival"], trip["loadedPath"])]:
            total = sum(dist(a, b) for a, b in pairwise(path))
            elapsed = start
            for a, b in pairwise(path):
                arrive = elapsed + (end - start) * dist(a, b) / total
                if a[1] == b[1] == 0:
                    reservations["同向车距", a, b].append((elapsed, elapsed + 1, trip))
                    reservations["交叉节点", b].append((arrive, arrive + 1, trip))
                else:
                    reservations["岛口窄段", *sorted((a, b))].append((elapsed, arrive, trip))
                    junction = a if a[1] == 0 else b
                    at = elapsed if junction == a else arrive
                    reservations["交叉节点", junction].append((at, at + 1, trip))
                elapsed = arrive
    count, examples = 0, []
    for location, intervals in reservations.items():
        active = []
        seen = set()
        for start, end, this in sorted(intervals, key=lambda item: item[:2]):
            signature = this["id"], round(start, 6), round(end, 6)
            if signature in seen:
                continue
            seen.add(signature)
            active = [row for row in active if row[1] > start + 1e-6]
            for _, _, other in active:
                if this["vehicle"] != other["vehicle"]:
                    count += 1
                    if len(examples) < 50:
                        examples.append(dict(kind=location[0], time=round(start, 1),
                                             trips=[other["id"], this["id"]], location=location[1:]))
            active.append((start, end, this))
    return count, examples


def generate_plan(settings, fixture):
    config = checked_settings(settings, fixture)
    routes = {kind: [op | {"duration": config["routeTimes"].get(op["label"], op["duration"])}
                     for op in route] for kind, route in fixture["routes"].items()}
    print_times = {int(n): 60 * config["printTimes"].get(n, t) for n, t in fixture["printTimes"].items()}
    layout = make_layout(config)
    policies = [(max(print_times), config["orders"], "较大批次投放"),
                (max(1, ceil(config["orders"] / config["printMachines"])),
                 config["orders"], "按设备均衡批次")]
    best = None
    attempts = 0
    for limit, wip, mode in dict.fromkeys(policies):
        candidate = Schedule(config, routes, print_times, layout, limit, wip, mode).run()
        attempts += 1
        if best is None or candidate.score() < best.score():
            best = candidate
    if len(best.completed) < config["orders"]:
        # At most three simultaneous part units per admitted order. Limiting WIP
        # reduces pressure without relaxing the configured capacities or fleet.
        wip = max(1, min(config["orders"], min(config["buffer"], config["restBuffer"]) // 3))
        for limit in dict.fromkeys((wip, 1)):
            candidate = Schedule(config, routes, print_times, layout, limit, wip, "错峰投放").run()
            attempts += 1
            if candidate.score() < best.score():
                best = candidate
            if len(best.completed) == config["orders"]:
                break
    return best.export(attempts)


def plan_json(settings_json, fixture_json):
    return json.dumps(generate_plan(json.loads(settings_json), json.loads(fixture_json)),
                      ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--settings", type=Path)
    parser.add_argument("--fixture", type=Path, default=Path(__file__).with_name("fixture.json"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    payload = plan_json(args.settings.read_text(encoding="utf-8") if args.settings else "{}",
                        args.fixture.read_text(encoding="utf-8"))
    if args.output:
        args.output.write_text(payload + "\n", encoding="utf-8")
    else:
        print(payload)


if __name__ == "__main__":
    main()
