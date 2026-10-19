on run argv
  set targetApp to item 1 of argv
  set maxNodes to (item 2 of argv) as integer
  set out to ""
  set n to 0
  tell application "System Events"
    if targetApp is "" then
      set proc to first application process whose frontmost is true
    else
      set proc to first application process whose name is targetApp
    end if
    set out to "app|" & (name of proc) & linefeed
    repeat with w in (windows of proc)
      if n is greater than or equal to maxNodes then exit repeat
      set out to out & "window|" & (name of w) & "||" & linefeed
      set n to n + 1
      repeat with e in (entire contents of w)
        if n is greater than or equal to maxNodes then exit repeat
        set r to ""
        set t to ""
        set v to ""
        try
          set r to (class of e) as string
        end try
        try
          set t to (name of e) as string
        end try
        try
          set v to (value of e) as string
        end try
        if t is not "" or v is not "" then
          set out to out & r & "|" & t & "|" & v & linefeed
          set n to n + 1
        end if
      end repeat
    end repeat
  end tell
  return out
end run
