on run argv
  set appName to item 1 of argv
  set report to ""
  tell application "System Events"
    if appName is not "" then
      set proc to first application process whose name is appName
      set frontmost of proc to true
      delay 0.2
    else
      set proc to first application process whose frontmost is true
    end if
    repeat with i from 2 to (count of argv)
      set step to item i of argv
      set AppleScript's text item delimiters to "::"
      set parts to text items of step
      set AppleScript's text item delimiters to ""
      set verb to item 1 of parts
      if verb is "press" then
        set elemName to item 2 of parts
        set hit to false
        repeat with w in (windows of proc)
          repeat with e in (entire contents of w)
            if hit is false then
              try
                if (name of e) is elemName then
                  perform action "AXPress" of e
                  set hit to true
                end if
              end try
            end if
          end repeat
        end repeat
        if hit then
          set report to report & "ok|press|" & elemName & linefeed
        else
          set report to report & "miss|press|" & elemName & linefeed
        end if
      else if verb is "clickxy" then
        set px to (item 2 of parts) as integer
        set py to (item 3 of parts) as integer
        click at {px, py}
        set report to report & "ok|clickxy|" & px & "," & py & linefeed
      else if verb is "type" then
        keystroke (item 2 of parts)
        set report to report & "ok|type|" & (length of (item 2 of parts)) & " chars" & linefeed
      else if verb is "key" then
        key code ((item 2 of parts) as integer)
        set report to report & "ok|key|" & (item 2 of parts) & linefeed
      else if verb is "wait" then
        delay ((item 2 of parts) as number)
        set report to report & "ok|wait|" & (item 2 of parts) & linefeed
      else
        set report to report & "err|unknown verb|" & verb & linefeed
      end if
    end repeat
  end tell
  return report
end run
