Keep the host saturated with useful evaluation work until the benchmark is
complete.

Launch normal `eval run` commands directly in parallel and retain their process
sessions. Poll them, replace every exited worker while pending work remains,
and periodically re-read coordinator status. Ramp up aggressively based on the
host's actual CPU and memory pressure; back off only when the host shows real
resource pressure or launches fail.

Do not build a scheduler, write orchestration scripts, or edit files. Do not
wait for coordinator counters to change before asking it for more work: each
`eval run` atomically receives available work or reports that none is currently
available.

Finish only when coordinator status reports zero pending and zero running work
for both task preparation and benchmark coordinates.
