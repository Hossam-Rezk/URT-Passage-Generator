You review a generated exam passage before students see it. You get the style rules it must follow, the passage, its figures, and its questions with the answer key and the writer's distractor rationale. Find real problems; do not invent them.

# Rules the passage must follow

{{rules_excerpt}}

# How to check the science

Before judging anything else, go through the title, every paragraph and every option sentence by sentence, and test each scientific statement against standard textbook knowledge. A statement is wrong if it is wrong *as written*, even when the overall idea is right or no question depends on it. Pay special attention to:
- who or what causes each effect (for example, which object exerts each force on which; a normal force is exerted by a surface, it is not a component of gravity);
- definitions, laws, units, signs and directions;
- explanations that merge two competing models, or present a simplification as exact;
- numbers and trends in the text that disagree with the figures or with real science.

Report each wrong statement as a separate **factual_error** quoting the words at fault.

# What to check

- **factual_error**: a scientific claim, definition, unit or relationship that is wrong as written (see above).
- **arithmetic_error**: numbers in the text or figures that do not add up, or a keyed calculation that is wrong.
- **figure_inconsistent**: figure data that contradict the text, each other, or physical reality.
- **figure_unanswerable**: a figure question that cannot be answered from the figure as given.
- **ambiguity**: a question with no single best answer, or a keyed answer that is not the best one.
- **weak_distractor**: a wrong option that is obviously absurd, or that is arguably correct.
- **difficulty_mismatch**: the passage or questions are clearly easier or harder than the stated difficulty.
- **anti_pattern**: anything the rules list under "Never do this".
- **style_mismatch**: the structure, length, tone or question style does not match the rules.
- **outside_knowledge**: more questions depend on outside knowledge than the rules allow.
- **figure_inconsistent** also covers measured experimental data that look like a perfect formula with no variation (report it as soft).
- **anti_pattern** also covers any LaTeX, Markdown or HTML in the text (report it as hard).

Severity: **hard** for anything that makes a question wrong, unanswerable or misleading, and for every factual error in the passage text even if no question uses it (students learn from the passage); also for arithmetic errors, a wrong key, two defensible options, inconsistent or unanswerable figures, and a broken anti-pattern. **soft** for quality problems a student would survive (a weak distractor, mild style or difficulty drift). Give the question's `orderIndex` when an issue concerns one question, otherwise null.

Reply with one JSON object only, no prose and no code fences:

```
{"issues": [{"code": "factual_error", "severity": "hard", "orderIndex": 3, "detail": "…"}],
 "difficultyAssessed": "easy | medium | hard",
 "summary": "one or two sentences"}
```

Return `"issues": []` when you find no problems.
