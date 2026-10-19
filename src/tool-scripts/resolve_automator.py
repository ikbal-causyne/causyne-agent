import sys
import json
import os

def run_bridge(args):
    try:
        import DaVinciResolveScript as dvr_script
    except ImportError:
        print(json.dumps({"success": False, "error": "[ENGINE MISSING] DaVinci Resolve Studio Python API not found. Please ensure 'External scripting using: Local' is enabled in Preferences -> System -> General, and DaVinci Resolve Studio is running."}))
        return

    resolve = dvr_script.scriptapp("Resolve")
    if resolve is None:
        print(json.dumps({"success": False, "error": "[CONNECTION ERROR] Could not connect to DaVinci Resolve. Please ensure DaVinci Resolve Studio is open."}))
        return

    projectManager = resolve.GetProjectManager()
    project = projectManager.GetCurrentProject()
    if not project:
        print(json.dumps({"success": False, "error": "No open project found."}))
        return

    mediaPool = project.GetMediaPool()
    timeline = project.GetCurrentTimeline()

    action = args.get("action")
    
    if action == "checkConnection":
        print(json.dumps({
            "success": True, 
            "message": f"Connected to DaVinci Resolve. Active Project: {project.GetName()}"
        }))
        return

    elif action == "setupColorManagement":
        mode = args.get("color_space_mode", "automatic").lower()
        try:
            project.SetSetting("colorScienceMode", "davinciYRGBColorManaged")
            
            if mode == "automatic":
                project.SetSetting("automaticColorManagement", "1")
                print(json.dumps({
                    "success": True, 
                    "message": "Successfully applied Automatic Resolve Color Management (RCM). DaVinci will now auto-detect S-Log, LogC, BRAW, etc."
                }))
            else:
                project.SetSetting("automaticColorManagement", "0")
                project.SetSetting("colorSpaceManager", "Custom")
                project.SetSetting("colorSpaceInput", args.get("input_color_space", "ARRI LogC3"))
                project.SetSetting("colorSpaceTimeline", "DaVinci WG/Intermediate")
                project.SetSetting("colorSpaceOutput", args.get("output_color_space", "Rec.709 Gamma 2.4"))

                print(json.dumps({
                    "success": True, 
                    "message": f"Successfully applied Custom RCM: {args.get('input_color_space', 'ARRI LogC3')} to {args.get('output_color_space', 'Rec.709 Gamma 2.4')}."
                }))
        except Exception as e:
            print(json.dumps({"success": False, "error": f"Failed to setup RCM: {str(e)}"}))
        return

    elif action == "importAndAssemble":
        media_path = args.get("mediaPath")
        if not media_path or not os.path.exists(media_path):
            print(json.dumps({"success": False, "error": f"Media path not found: {media_path}"}))
            return

        try:
            imported_clips = mediaPool.ImportMedia([media_path])
            if not imported_clips:
                print(json.dumps({"success": False, "error": "No media found or imported."}))
                return
                
            fps = str(args.get("fps", "auto")).lower()
            res_x = str(args.get("resolution_x", "auto")).lower()
            res_y = str(args.get("resolution_y", "auto")).lower()
            
            if fps == "auto" or res_x == "auto" or res_y == "auto":
                first_clip = imported_clips[0]
                
                if fps == "auto":
                    detected_fps = first_clip.GetClipProperty("FPS")
                    fps = str(detected_fps) if detected_fps else "23.976"
                
                if res_x == "auto" or res_y == "auto":
                    detected_res = first_clip.GetClipProperty("Resolution")
                    if detected_res and "x" in str(detected_res):
                        parts = str(detected_res).split("x")
                        res_x, res_y = parts[0], parts[1]
                    else:
                        res_x, res_y = "4096", "2160"

            project.SetSetting("timelineFrameRate", fps)
            project.SetSetting("timelineResolutionWidth", res_x)
            project.SetSetting("timelineResolutionHeight", res_y)
            
            if not timeline:
                timeline = mediaPool.CreateEmptyTimeline("Causyne_Automated_Timeline")
                
            mediaPool.AppendToTimeline(imported_clips)
            
            print(json.dumps({
                "success": True, 
                "message": f"Successfully imported {len(imported_clips)} clips and auto-assembled on timeline '{timeline.GetName()}' at detected {res_x}x{res_y} {fps}fps."
            }))
        except Exception as e:
            print(json.dumps({"success": False, "error": f"Failed during auto-import/assembly: {str(e)}"}))
        return

    else:
        print(json.dumps({"success": False, "error": f"Unknown action: {action}"}))
        return

if __name__ == "__main__":
    try:
        raw_args = sys.argv[1]
        args = json.loads(raw_args)
        run_bridge(args)
    except Exception as e:
        print(json.dumps({"success": False, "error": f"Python Bridge Error: {str(e)}"}))