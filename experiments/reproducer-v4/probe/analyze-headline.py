"""Computes every metric the frozen probe requires and evaluates the frozen
decision rules. No thresholds are introduced here that are not in the manifest."""
import json, glob, statistics, sys, os

RUNS = sorted(glob.glob("../results/probe-headline/run-*.json"),
              key=lambda x: int(x.split("run-p")[1].split("-")[0]))
rows = [json.load(open(p)) for p in RUNS]
manifest = json.load(open("V4-PROBE-MANIFEST.json"))
CASES = manifest["probe_corpus"]["cases"]

VALID = {"CORRECT_FIX", "FALSE_FIX_ORIGINAL_FAILURE_REMAINS", "FALSE_FIX_OVERFIT",
         "REGRESSION_INTRODUCED", "TIMEOUT_NO_FIX", "AGENT_ABORTED"}
INVALID = {"INVALID_HARNESS", "INVALID_LEAKAGE", "RESOURCE_BLOCKED"}

valid = [r for r in rows if r["classification"] in VALID]
invalid = [r for r in rows if r["classification"] in INVALID]

def arm(a): return [r for r in valid if r["arm"] == a]
def rate(rs, cls="CORRECT_FIX"):
    return (sum(1 for r in rs if r["classification"] == cls) / len(rs) * 100) if rs else None

C, T = arm("CONTROL"), arm("TREATMENT")
summary = {
  "runs_recorded": len(rows), "valid_runs": len(valid), "invalid_runs": len(invalid),
  "invalid_detail": [{"label": r["label"], "classification": r["classification"],
                      "reason": r.get("invalid_reason")} for r in invalid],
  "correct_fix_rate": {"CONTROL": rate(C), "TREATMENT": rate(T),
                       "absolute_difference_pp": (rate(T) - rate(C)) if (C and T) else None},
  "false_fix_rate": {a: (sum(1 for r in g if r["classification"].startswith("FALSE_FIX")) / len(g) * 100
                         if g else None) for a, g in (("CONTROL", C), ("TREATMENT", T))},
  "regression_rate": {a: (sum(1 for r in g if r["classification"] == "REGRESSION_INTRODUCED") / len(g) * 100
                          if g else None) for a, g in (("CONTROL", C), ("TREATMENT", T))},
  "timeout_rate": {a: (sum(1 for r in g if r["classification"] == "TIMEOUT_NO_FIX") / len(g) * 100
                       if g else None) for a, g in (("CONTROL", C), ("TREATMENT", T))},
}

# ---- per-case paired comparison -------------------------------------------
per_case, wins, ties, losses = [], 0, 0, 0
for case in CASES:
    c = [r for r in C if r["case"] == case]
    t = [r for r in T if r["case"] == case]
    cf_c = sum(1 for r in c if r["classification"] == "CORRECT_FIX")
    cf_t = sum(1 for r in t if r["classification"] == "CORRECT_FIX")
    verdict = "TREATMENT_WINS" if cf_t > cf_c else "TREATMENT_LOSES" if cf_t < cf_c else "TIE"
    wins += verdict == "TREATMENT_WINS"; losses += verdict == "TREATMENT_LOSES"; ties += verdict == "TIE"
    per_case.append({"case": case, "control_correct": f"{cf_c}/{len(c)}", "treatment_correct": f"{cf_t}/{len(t)}",
        "verdict": verdict,
        "control_classes": [r["classification"] for r in c],
        "treatment_classes": [r["classification"] for r in t],
        "control_seconds": [r["agent_seconds"] for r in c],
        "treatment_seconds": [r["agent_seconds"] for r in t]})
summary["per_case"] = per_case
summary["paired"] = {"treatment_wins": wins, "ties": ties, "treatment_losses": losses}

# ---- efficiency, on SUCCESSFUL runs only ----------------------------------
def med(xs): return statistics.median(xs) if xs else None
succ = lambda g: [r for r in g if r["classification"] == "CORRECT_FIX"]
metrics = {}
for name, key in (("wall_clock_seconds", lambda r: r["agent_seconds"]),
                  ("tool_calls", lambda r: r["observations"]["tool_calls"]),
                  ("test_invocations", lambda r: r["observations"]["test_invocations"])):
    mc, mt = med([key(r) for r in succ(C)]), med([key(r) for r in succ(T)])
    metrics[name] = {"CONTROL_median": mc, "TREATMENT_median": mt,
                     "improvement_pct": (round((mc - mt) / mc * 100, 1) if mc and mt else None)}
summary["efficiency_on_successful_runs"] = metrics

# ---- artifact usage --------------------------------------------------------
summary["repro_usage"] = {
  "treatment_runs_invoking_repro": sum(1 for r in T if r["observations"]["repro_invocations"] > 0),
  "treatment_runs_total": len(T),
  "invocations_per_run": [r["observations"]["repro_invocations"] for r in T],
  "first_invocation_trace_line": [r["observations"].get("first_repro_invocation_line") for r in T],
  "outcomes_observed": sorted({o for r in T for o in r["observations"]["repro_outcome_lines"]}),
  "control_runs_invoking_repro": sum(1 for r in C if r["observations"]["repro_invocations"] > 0),
}

# ---- network ---------------------------------------------------------------
net = {}
for r in valid:
    for k, v in (r.get("proxy_attempts") or {}).items():
        net[k] = net.get(k, 0) + v
summary["network_attempts_total"] = net
summary["agent_initiated_network_commands"] = sum(
    r["observations"].get("network_capable_commands", 0) for r in valid)
summary["agent_web_tool_attempts"] = sum(
    r["observations"].get("webfetch_or_search_attempts", 0) for r in valid)

# ---- resources -------------------------------------------------------------
summary["resources"] = {
  "free_mb_before_first": rows[0].get("free_mb_before") if rows else None,
  "free_mb_after_last": rows[-1].get("free_mb_after") if rows else None,
  "min_free_mb_observed": min([r.get("free_mb_after") or 10**9 for r in rows] or [None]),
  "floor_mb": rows[0].get("disk_floor_mb") if rows else None,
  "workspaces_retained": sum(1 for r in rows if r.get("workspace_retained")),
}

# ---- frozen decision rules -------------------------------------------------
cf_c, cf_t = summary["correct_fix_rate"]["CONTROL"], summary["correct_fix_rate"]["TREATMENT"]
ff_c, ff_t = summary["false_fix_rate"]["CONTROL"], summary["false_fix_rate"]["TREATMENT"]
rg_c, rg_t = summary["regression_rate"]["CONTROL"], summary["regression_rate"]["TREATMENT"]
diff = summary["correct_fix_rate"]["absolute_difference_pp"]
time_gain = metrics["wall_clock_seconds"]["improvement_pct"]
iter_gain = metrics["tool_calls"]["improvement_pct"]

ceiling = cf_c is not None and cf_c >= 80
checks = {}
if ceiling:
    checks["regime"] = "CONTROL_CEILING (control correct-fix >= 80%)"
    checks["treatment_not_worse_by_more_than_10pp"] = diff is not None and diff >= -10
    checks["median_time_improved_25pct_or_iterations_30pct"] = (
        (time_gain is not None and time_gain >= 25) or (iter_gain is not None and iter_gain >= 30))
    checks["false_fix_and_regression_not_worse"] = (ff_t <= ff_c and rg_t <= rg_c)
    strong = all(v for k, v in checks.items() if k != "regime")
else:
    checks["regime"] = "NORMAL_BASELINE (control correct-fix < 80%)"
    checks["treatment_improves_20pp"] = diff is not None and diff >= 20
    checks["treatment_wins_at_least_3_of_5"] = wins >= 3
    checks["treatment_loses_at_most_1_of_5"] = losses <= 1
    checks["false_fix_and_regression_not_materially_worse"] = (ff_t <= ff_c + 5 and rg_t <= rg_c + 5)
    strong = all(v for k, v in checks.items() if k != "regime")

no_efficiency_edge = not ((time_gain is not None and time_gain >= 20) or
                          (iter_gain is not None and iter_gain >= 20))
negative = (
    (diff is not None and diff < 10 and no_efficiency_edge)
    or (ff_t is not None and ff_c is not None and ff_t > ff_c + 5)
    or (rg_t is not None and rg_c is not None and rg_t > rg_c + 5)
)
verdict = "STRONG_POSITIVE_SIGNAL" if strong else ("NEGATIVE_SIGNAL" if negative else "INCONCLUSIVE")
summary["decision_rule_evaluation"] = checks
summary["decision_rule_evaluation"]["strong_positive_all_met"] = strong
summary["decision_rule_evaluation"]["negative_conditions_met"] = negative
summary["verdict"] = verdict

summary["raw_outcomes"] = [{
  "run": int(r["label"].split("-")[0][1:]), "case": r["case"], "arm": r["arm"],
  "classification": r["classification"], "seconds": r["agent_seconds"],
  "termination": r.get("termination_reason"), "patch_empty": r.get("patch_empty"),
  "tool_calls": r["observations"]["tool_calls"], "tests": r["observations"]["test_invocations"],
  "repro_invocations": r["observations"]["repro_invocations"],
  "tree_changed": r.get("tree_changed"),
  "starting_tree": (r.get("starting_tree") or {}).get("tree_sha256", "")[:12],
  "final_tree": (r.get("final_tree") or {}).get("tree_sha256", "")[:12],
} for r in rows]

json.dump(summary, open("../results/probe-headline-summary.json", "w"), indent=2)
print(json.dumps({k: v for k, v in summary.items() if k not in ("raw_outcomes", "per_case")}, indent=2))
