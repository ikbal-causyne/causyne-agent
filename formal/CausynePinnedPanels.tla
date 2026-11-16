----------------- MODULE CausynePinnedPanels -----------------
EXTENDS Naturals
VARIABLES panel, busy, queued, interrupted, lastAction, priorPanel, priorInterrupted

vars == <<panel, busy, queued, interrupted, lastAction, priorPanel, priorInterrupted>>

Init ==
  /\ panel = "none"
  /\ busy = FALSE
  /\ queued = 0
  /\ interrupted = FALSE
  /\ lastAction = "init"
  /\ priorPanel = "none"
  /\ priorInterrupted = FALSE

OpenUsage ==
  /\ panel # "usage"
  /\ panel' = "usage"
  /\ priorPanel' = panel
  /\ lastAction' = "open_usage"
  /\ priorInterrupted' = interrupted
  /\ UNCHANGED <<busy, queued, interrupted>>

OpenStatus ==
  /\ panel # "status"
  /\ panel' = "status"
  /\ priorPanel' = panel
  /\ lastAction' = "open_status"
  /\ priorInterrupted' = interrupted
  /\ UNCHANGED <<busy, queued, interrupted>>

ClosePanel ==
  /\ panel # "none"
  /\ panel' = "none"
  /\ priorPanel' = panel
  /\ lastAction' = "close"
  /\ priorInterrupted' = interrupted
  /\ UNCHANGED <<busy, queued, interrupted>>

Submit ==
  /\ queued < 2
  /\ queued' = queued + 1
  /\ priorPanel' = panel
  /\ lastAction' = "submit"
  /\ priorInterrupted' = interrupted
  /\ UNCHANGED <<panel, busy, interrupted>>

BeginRun ==
  /\ busy = FALSE
  /\ busy' = TRUE
  /\ priorPanel' = panel
  /\ lastAction' = "start"
  /\ priorInterrupted' = interrupted
  /\ UNCHANGED <<panel, queued, interrupted>>

FinishRun ==
  /\ busy = TRUE
  /\ busy' = FALSE
  /\ priorPanel' = panel
  /\ lastAction' = "finish"
  /\ priorInterrupted' = interrupted
  /\ UNCHANGED <<panel, queued, interrupted>>

Dequeue ==
  /\ queued > 0
  /\ queued' = queued - 1
  /\ priorPanel' = panel
  /\ lastAction' = "dequeue"
  /\ priorInterrupted' = interrupted
  /\ UNCHANGED <<panel, busy, interrupted>>

EscapePanel ==
  /\ panel # "none"
  /\ panel' = "none"
  /\ priorPanel' = panel
  /\ priorInterrupted' = interrupted
  /\ lastAction' = "escape_panel"
  /\ UNCHANGED <<busy, queued, interrupted>>

EscapeRun ==
  /\ panel = "none"
  /\ busy = TRUE
  /\ interrupted' = TRUE
  /\ priorInterrupted' = interrupted
  /\ priorPanel' = panel
  /\ lastAction' = "escape_run"
  /\ UNCHANGED <<panel, busy, queued>>

Next ==
  \/ OpenUsage
  \/ OpenStatus
  \/ ClosePanel
  \/ Submit
  \/ BeginRun
  \/ FinishRun
  \/ Dequeue
  \/ EscapePanel
  \/ EscapeRun

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ panel \in {"none", "usage", "status"}
  /\ busy \in BOOLEAN
  /\ queued \in 0..2
  /\ interrupted \in BOOLEAN
  /\ priorPanel \in {"none", "usage", "status"}
  /\ priorInterrupted \in BOOLEAN

PinnedUntilClose ==
  lastAction \in {"submit", "start", "finish", "dequeue"}
    => panel = priorPanel

NoRunInterruptFromPanel ==
  lastAction = "escape_panel" => interrupted = priorInterrupted
==============================================================
