- Run as many evals in parallel as the host can sustain. Aggressively add waves
  until memory is nearly exhausted or the host shows pressure or failures;
  never settle while capacity is idle.

- Monitor every eval directly and replace it as soon as it finishes while work
  remains. Never write a script or start another scheduler.

- Keep going until there is no eval work left.
