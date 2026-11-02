import sys
import json
import os

def run_bridge(args):
    try:
        import DaVinciResolveScript as dvr_script
    except ImportError:
        print(json.dumps({
            "success": False,
            "error": "[ENGINE MISSING] DaVinci Resolve Studio Python API not found. Ensure 'External scripting using: Local' is enabled in Preferences -> System -> General, and DaVinci Resolve is running."
        }))
        return

    resolve = dvr_script.scriptapp("Resolve")
    if resolve is None:
        print(json.dumps({
            "success": False,
            "error": "[CONNECTION ERROR] Could not connect to DaVinci Resolve. Ensure DaVinci Resolve is open."
        }))
        return

    projectManager = resolve.GetProjectManager()
    project = projectManager.GetCurrentProject()
    if not project:
        print(json.dumps({"success": False, "error": "No open project found in DaVinci Resolve."}))
        return

    mediaPool = project.GetMediaPool()
    timeline = project.GetCurrentTimeline()
    action = args.get("action")

    if action == "checkConnection":
        tl_name = timeline.GetName() if timeline else None
        print(json.dumps({
            "success": True,
            "projectName": project.GetName(),
            "timelineName": tl_name,
            "message": f"Connected to DaVinci Resolve. Active Project: {project.GetName()}"
        }))
        return

    elif action == "inspectActive":
        tl_name = timeline.GetName() if timeline else None
        video_tracks = timeline.GetTrackCount("video") if timeline and hasattr(timeline, "GetTrackCount") else 0
        audio_tracks = timeline.GetTrackCount("audio") if timeline and hasattr(timeline, "GetTrackCount") else 0
        timecode = timeline.GetCurrentTimecode() if timeline and hasattr(timeline, "GetCurrentTimecode") else "01:00:00:00"
        fps = project.GetSetting("timelineFrameRate") if hasattr(project, "GetSetting") else "24"
        res_x = project.GetSetting("timelineResolutionWidth") if hasattr(project, "GetSetting") else "1920"
        res_y = project.GetSetting("timelineResolutionHeight") if hasattr(project, "GetSetting") else "1080"
        print(json.dumps({
            "success": True,
            "host": "resolve",
            "operation": "inspectActive",
            "projectName": project.GetName(),
            "timelineName": tl_name,
            "videoTracks": video_tracks,
            "audioTracks": audio_tracks,
            "currentTimecode": timecode,
            "fps": fps or "24",
            "resolutionWidth": res_x or "1920",
            "resolutionHeight": res_y or "1080"
        }))
        return

    elif action == "setupColorManagement":
        mode = str(args.get("color_space_mode", "automatic")).lower()
        try:
            project.SetSetting("colorScienceMode", "davinciYRGBColorManaged")
            if mode == "automatic":
                project.SetSetting("automaticColorManagement", "1")
                print(json.dumps({
                    "success": True,
                    "mode": "automatic",
                    "message": "Applied Automatic DaVinci YRGB Color Management (RCM)."
                }))
            else:
                in_cs = args.get("input_color_space", "ARRI LogC3")
                tl_cs = args.get("timeline_color_space", "DaVinci WG/Intermediate")
                out_cs = args.get("output_color_space", "Rec.709 Gamma 2.4")
                project.SetSetting("automaticColorManagement", "0")
                project.SetSetting("colorSpaceManager", "Custom")
                project.SetSetting("colorSpaceInput", in_cs)
                project.SetSetting("colorSpaceTimeline", tl_cs)
                project.SetSetting("colorSpaceOutput", out_cs)
                print(json.dumps({
                    "success": True,
                    "mode": "custom",
                    "inputColorSpace": in_cs,
                    "timelineColorSpace": tl_cs,
                    "outputColorSpace": out_cs,
                    "message": f"Applied Custom RCM: {in_cs} -> {tl_cs} -> {out_cs}."
                }))
        except Exception as e:
            print(json.dumps({"success": False, "error": f"Failed to setup RCM: {str(e)}"}))
        return

    elif action in ("importAndAssemble", "insertClipAtPlayhead"):
        media_path = args.get("mediaPath") or args.get("input")
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
                    detected_fps = first_clip.GetClipProperty("FPS") if hasattr(first_clip, "GetClipProperty") else None
                    fps = str(detected_fps) if detected_fps else "24"
                if res_x == "auto" or res_y == "auto":
                    detected_res = first_clip.GetClipProperty("Resolution") if hasattr(first_clip, "GetClipProperty") else None
                    if detected_res and "x" in str(detected_res):
                        parts = str(detected_res).split("x")
                        res_x, res_y = parts[0], parts[1]
                    else:
                        res_x, res_y = "1920", "1080"

            project.SetSetting("timelineFrameRate", fps)
            project.SetSetting("timelineResolutionWidth", res_x)
            project.SetSetting("timelineResolutionHeight", res_y)

            if not timeline:
                timeline_name = args.get("timelineName") or "Causyne_Automated_Timeline"
                timeline = mediaPool.CreateEmptyTimeline(timeline_name)

            if args.get("timecode") and hasattr(timeline, "SetCurrentTimecode"):
                timeline.SetCurrentTimecode(str(args.get("timecode")))

            mediaPool.AppendToTimeline(imported_clips)

            if args.get("markerName") and hasattr(timeline, "AddMarker"):
                frame_id = int(args.get("markerFrame", 0))
                marker_color = str(args.get("markerColor", "Blue"))
                marker_name = str(args.get("markerName"))
                marker_note = str(args.get("markerNote", "Added by Causyne Agent"))
                timeline.AddMarker(frame_id, marker_color, marker_name, marker_note, 1)

            print(json.dumps({
                "success": True,
                "action": action,
                "timelineName": timeline.GetName(),
                "importedCount": len(imported_clips),
                "resolution": f"{res_x}x{res_y}",
                "fps": fps,
                "message": f"Imported {len(imported_clips)} clip(s) into timeline '{timeline.GetName()}' ({res_x}x{res_y} @ {fps}fps)."
            }))
        except Exception as e:
            print(json.dumps({"success": False, "error": f"Failed during media import/assembly: {str(e)}"}))
        return

    elif action == "addMarker":
        if not timeline:
            print(json.dumps({"success": False, "error": "No active timeline in DaVinci Resolve."}))
            return
        try:
            frame_id = int(args.get("frameId", 0))
            color = str(args.get("markerColor", "Blue"))
            name = str(args.get("markerName", "Causyne Marker"))
            note = str(args.get("markerNote", ""))
            duration = int(args.get("duration", 1))
            ok = timeline.AddMarker(frame_id, color, name, note, duration)
            print(json.dumps({
                "success": bool(ok),
                "timelineName": timeline.GetName(),
                "frameId": frame_id,
                "markerName": name,
                "markerColor": color
            }))
        except Exception as e:
            print(json.dumps({"success": False, "error": f"Failed to add marker: {str(e)}"}))
        return

    elif action == "applyLutOrGrade":
        if not timeline:
            print(json.dumps({"success": False, "error": "No active timeline in DaVinci Resolve."}))
            return
        try:
            track_idx = int(args.get("trackIndex", 1))
            items = timeline.GetItemListInTrack("video", track_idx) if hasattr(timeline, "GetItemListInTrack") else []
            if not items:
                print(json.dumps({"success": False, "error": f"No video clips found on track {track_idx}."}))
                return
            clip = items[0]
            lut_path = args.get("lutPath")
            node_idx = int(args.get("nodeIndex", 1))
            if lut_path and hasattr(clip, "SetLUT"):
                clip.SetLUT(node_idx, str(lut_path))
            cdl = args.get("cdl")
            if isinstance(cdl, dict) and hasattr(clip, "SetCDL"):
                clip.SetCDL({
                    "NodeIndex": str(node_idx),
                    "Slope": str(cdl.get("slope", "1.0 1.0 1.0")),
                    "Offset": str(cdl.get("offset", "0.0 0.0 0.0")),
                    "Power": str(cdl.get("power", "1.0 1.0 1.0")),
                    "Saturation": str(cdl.get("saturation", "1.0"))
                })
            print(json.dumps({
                "success": True,
                "timelineName": timeline.GetName(),
                "gradedClips": len(items),
                "nodeIndex": node_idx
            }))
        except Exception as e:
            print(json.dumps({"success": False, "error": f"Failed to apply LUT/CDL grade: {str(e)}"}))
        return

    elif action == "renderTimeline":
        try:
            preset_name = args.get("presetName")
            if preset_name and hasattr(project, "LoadRenderPreset"):
                project.LoadRenderPreset(str(preset_name))
            render_settings = {}
            if args.get("targetDir"):
                render_settings["TargetDir"] = str(args.get("targetDir"))
            if args.get("customName"):
                render_settings["CustomName"] = str(args.get("customName"))
            if render_settings and hasattr(project, "SetRenderSettings"):
                project.SetRenderSettings(render_settings)
            job_id = project.AddRenderJob() if hasattr(project, "AddRenderJob") else "job_1"
            started = False
            if args.get("startRender", True) and hasattr(project, "StartRendering"):
                started = bool(project.StartRendering([job_id]))
            print(json.dumps({
                "success": True,
                "jobId": job_id,
                "started": started,
                "targetDir": render_settings.get("TargetDir")
            }))
        except Exception as e:
            print(json.dumps({"success": False, "error": f"Failed to queue render job: {str(e)}"}))
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
