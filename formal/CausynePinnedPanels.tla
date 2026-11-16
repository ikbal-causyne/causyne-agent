----------------- MODULE CausynePinnedPanels -----------------
EXTENDS Naturals
VARIABLES panel, busy, queued, interrupted, lastAction, priorPanel

vars == <<panel, busy, queued, interrupted, lastAction, priorPanel>>

Init ==
  /\ panel = "none"
  /\ busy = FALSE
  /\ queued = 0
  /\ interrupted = FALSE
  /\ lastAction = "init"
  /\ priorPanel = "none"

OpenUsage ==
  /\ panel # "usage"
  /\ panel' = "usage"
  /\ priorPanel' = panel
  /\ lastAction' = "open_usage"
  /\ UNCHANGED <<busy, queued, interrupted>>

OpenStatus ==
  /\ panel # "status"
  /\ panel' = "status"
  /\ priorPanel' = panel
  /\ lastAction' = "open_status"
  /\ UNCHANGED <<busy, queued, interrupted>>

ClosePanel ==
  /\ panel # "none"
  /\ panel' = "none"
  /\ priorPanel' = panel
  /\ lastAction' = "close"
  /\ UNCHANGED <<busy, queued, interrupted>>

Submit ==
  /\ queued < 2
  /\ queued' = queued + 1
  /\ priorPanel' = panel
  /\ lastAction' = "submit"
  /\ UNCHANGED <<panel, busy, interrupted>>

BeginRun ==
  /\ busy = FALSE
  /\ busy' = TRUE
  /\ priorPanel' = panel
  /\ lastAction' = "start"
  /\ UNCHANGED <<panel, queued, interrupted>>

FinishRun ==
  /\ busy = TRUE
  /\ busy' = FALSE
  /\ priorPanel' = panel
  /\ lastAction' = "finish"
  /\ UNCHANGED <<panel, queued, interrupted>>

Dequeue ==
  /\ queued > 0
  /\ queued' = queued - 1
  /\ priorPanel' = panel
  /\ lastAction' = "dequeue"
  /\ UNCHANGED <<panel, busy, interrupted>>

Next ==
  \/ OpenUsage
  \/ OpenStatus
  \/ ClosePanel
  \/ Submit
  \/ BeginRun
  \/ FinishRun
  \/ Dequeue

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ panel \in {"none", "usage", "status"}
  /\ busy \in BOOLEAN
  /\ queued \in 0..2
  /\ interrupted \in BOOLEAN
  /\ priorPanel \in {"none", "usage", "status"}

PinnedUntilClose ==
  lastAction \in {"submit", "start", "finish", "dequeue"}
    => panel = priorPanel

NoRunInterruptFromPanel ==
  interrupted = FALSE
==============================================================
