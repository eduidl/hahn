------------------------------ MODULE Stream ------------------------------
EXTENDS Naturals, Sequences, TLC

CONSTANT MaxEvents
VARIABLES kind, queue, sent, server, client, terminal, frames, received
vars == <<kind, queue, sent, server, client, terminal, frames, received>>

Init ==
  /\ kind \in {"messages", "views", "latest"}
  /\ queue = <<>> /\ sent = 0 /\ server = "open"
  /\ client = "reading" /\ terminal = "none" /\ frames = 0
  /\ received = <<>>

Send(e) ==
  /\ server = "open" /\ sent < MaxEvents
  /\ e \in (IF kind = "messages" THEN {"batch", "complete", "error"}
             ELSE {"frame", "frameError", "complete", "error"})
  /\ kind # "latest" \/ e \notin {"frame", "frameError"} \/ frames = 0
  /\ queue' = Append(queue, e) /\ sent' = sent + 1
  /\ frames' = frames + IF e \in {"frame", "frameError"} THEN 1 ELSE 0
  /\ server' = IF e \in {"complete", "error"} THEN "closed" ELSE server
  /\ UNCHANGED <<kind, client, terminal, received>>

Disconnect ==
  /\ server = "open" /\ server' = "closed"
  /\ UNCHANGED <<kind, queue, sent, client, terminal, frames, received>>

Receive ==
  /\ client = "reading" /\ Len(queue) > 0
  /\ LET e == Head(queue) IN
       /\ queue' = Tail(queue)
       /\ received' = Append(received, e)
       /\ terminal' = IF e \in {"complete", "error"} THEN e ELSE terminal
       /\ client' = IF e = "error" THEN "failed" ELSE client
  /\ UNCHANGED <<kind, sent, server, frames>>

End ==
  /\ client = "reading" /\ server = "closed" /\ Len(queue) = 0
  /\ client' = IF terminal = "complete" THEN "success" ELSE "failed"
  /\ UNCHANGED <<kind, queue, sent, server, terminal, frames, received>>

Next == (\E e \in {"batch", "frame", "frameError", "complete", "error"}: Send(e))
        \/ Disconnect \/ Receive \/ End
Spec == Init /\ [][Next]_vars

SuccessHasComplete == client = "success" => terminal = "complete"
NoFalseSuccess == client = "success" => \E i \in 1..Len(received): received[i] = "complete"
LatestAtMostOne == kind = "latest" => frames <= 1
ErrorFails == terminal = "error" => client = "failed"
FrameErrorContinues == client = "reading" /\ Len(received) > 0 /\
  received[Len(received)] = "frameError" => terminal = "none"
=============================================================================
