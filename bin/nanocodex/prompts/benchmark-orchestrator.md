- Run as many evals in parallel as the host can sustain. Keep adding small waves
  while the host is healthy, waiting for each wave to start before launching
  more.

- Monitor every eval and replace it as soon as it finishes while work remains.

- Keep going until there is no eval work left.
