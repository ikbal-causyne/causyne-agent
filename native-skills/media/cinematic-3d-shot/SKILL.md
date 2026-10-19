---
name: cinematic-3d-shot
description: Build a 3D object in Blender and render it as a short cinematic clip. Use when a task asks for a 3D model, a product shot, a turntable, or a rendered animation of a few seconds.
---

# Cinematic 3D Shot

A render looks amateur for four reasons, always the same four: default grey
material, one flat light, the camera where Blender left it, and nobody looked at
the result before shipping it. Fix those four and an ordinary model reads as a
product shot.

## Workflow

1. Verify Blender before planning anything.
   - Use the local CLI path. Budget a low-cost `renderFrame` whenever you need
     to inspect the current visual result.
   - **Done when:** the local Blender binary is available and the review loop is planned.

2. Clear the scene.
   - Blender opens with a cube, one lamp and a camera. Building around them is
     how the default cube ends up in a client render.
   - **Done when:** `clearScene` has run.

3. Build the silhouette, then the detail.
   - A shape is read as an outline before it is read as a surface. If the form
     does not identify itself at thumbnail size, no amount of material work will
     save it. Use `smartGeometry` — it applies bevel and subdivision, and a
     bevel is what catches a highlight along an edge. Perfectly sharp edges are
     the most common tell of untouched 3D: nothing in the real world has them.
   - **Done when:** the object is recognisable as a flat grey silhouette.

4. Give every visible object a material.
   - `smartMaterial` on each one. One untouched object in a dressed scene reads
     as unfinished more loudly than a whole scene of grey.
   - Match the material to the object's story: a pen barrel is brushed metal or
     lacquered resin, not plastic; the grip is rubber, and rubber is rough where
     metal is not. Contrast between materials is what tells the eye there are
     two parts.
   - **Done when:** no object still carries the default surface.

5. Light with three lights, in this order.
   - `setupStudioLighting` gives key, fill and rim. The ratio does the work:
     the key states the form, the fill keeps the shadow side from going black,
     and the RIM is what separates the subject from the background. A render
     that looks flat is almost always missing the rim.
   - **Done when:** the subject's edge is visibly brighter than what is behind it.

6. Add atmosphere only after the lights exist.
   - `cinematicAtmosphere`. Fog scatters the light you already have, so adding
     it first means tuning against something that will change. Keep the density
     low — visible haze reads as a mistake unless the shot is about weather.
   - **Done when:** there is depth between foreground and background, and the
     subject is still crisp.

7. Frame it deliberately.
   - `autoFrameCamera`. A longer lens (65mm and up) flatters an object; a wide
     lens distorts it and is why so many AI renders look like a fisheye photo of
     a toy. Put the camera slightly above the eye line and the subject a little
     off-centre.
   - **Done when:** the camera is not where Blender put it.

8. Look at it before you animate.
   - `captureViewport`, or one low-sample `renderFrame`, then `view_image` or
     `vision_inspect_ui`. Ask the specific question: is anything still grey, is
     the subject separated from the background, does the silhouette read?
   - **A render nobody has looked at is not a finished render.** This step is
     the difference between the two outcomes, not a formality.
   - **Done when:** you have described what you actually see, not what you
     intended to build.

9. One camera move, and do the arithmetic out loud.
   - Seconds x fps = frames. 8s at 24fps is frames 1-192; set the range
     explicitly or Blender renders its own 250-frame default.
   - ONE move per short shot: a slow orbit, a push-in, or a rise. Three moves in
     eight seconds reads as a screensaver. Ease the ends — constant velocity is
     what makes a move feel mechanical.
   - **Done when:** the frame range matches the requested duration exactly.

10. Render with settings that fit the budget.
    - EEVEE for anything short. Cycles at default samples will spend an entire
      task budget on one frame and is almost never what a few seconds of
      turntable needs.
    - **Done when:** the file exists, and you have opened it to confirm it is
      not zero bytes or a single black frame.

## Failure modes worth naming

- **Everything is grey.** A material step was skipped, or applied to one object.
- **It looks flat.** No rim light, or fill too close to key.
- **The object looks like a toy.** Lens too wide, or the camera is too close.
- **The animation stutters.** Frame range and fps disagree with the duration.
- **Blender is not installed.** Say so and offer the alternative. Do not loop
  retrying the same missing binary — that spends budget to learn nothing.

## Verification

- The rendered file exists, is larger than a few kilobytes, and opens.
- Open the first frame and the middle frame. Neither is black, neither is empty,
  and the subject is in frame in both.
- No object in shot still carries the default grey surface.
- The subject's edge is brighter than the background directly behind it.
- Frame count equals requested seconds x fps, exactly.
- The camera position differs from Blender's default.
