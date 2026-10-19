Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$max = [int]$args[0]
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = [System.Windows.Automation.Condition]::TrueCondition
$n = 0
foreach ($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
  if ($n -ge $max) { break }
  $name = $e.Current.Name
  if ($name) { Write-Output ("" + $e.Current.ControlType.ProgrammaticName + "|" + $name + "|"); $n++ }
}
