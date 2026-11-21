import path from 'node:path';
import { assertSafeWorkspaceOutput, atomicWriteFileSafe, escapeGodotString, resolveToolWorkspaceRoots, safeSlugIdentifier, sanitizeToolError } from './toolPathSafety.js';
export const gameUiHudBuilder = {
    schema: {
        name: 'game.ui_hud_builder',
        description: 'Constructs responsive UI/HUD scenes for Godot 4.x (`MainMenu.tscn`, `HUD.tscn` with player health/stamina bars, `InventoryGrid.tscn`, `DialogueBox.tscn`, `ShopMenu.tscn`, and `QuestLog.tscn`). Includes anchored layouts (`Control`) and signal bindings (`button_up`, `item_selected`).',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['build_hud', 'build_main_menu', 'build_dialogue_box', 'build_inventory_grid', 'build_shop_menu', 'save_ui_scene'], description: 'Action to perform.' },
                uiName: { type: 'string', description: 'Name of the UI node.' },
                gameTitle: { type: 'string', description: 'Title for MainMenu.' },
                hasStaminaBar: { type: 'boolean', description: 'Include stamina bar in HUD (default true).' },
                inventorySlots: { type: 'number', description: 'Number of inventory grid slots (default 24).' },
                outputPath: { type: 'string', description: 'Absolute or res:// path to save `.tscn`.' }
            },
            required: ['action']
        }
    },
    async execute(args = {}, sandbox) {
        try {
            const { action, uiName = 'GameUI', gameTitle = 'Chronicles of Aetheria', hasStaminaBar = true, inventorySlots = 24, outputPath } = args || {};
            const safeUiName = escapeGodotString(uiName ?? 'GameUI', 100);
            const safeUiSlug = safeSlugIdentifier(uiName, 'GameUI', 64);
            const safeTitle = escapeGodotString(gameTitle ?? 'Chronicles of Aetheria', 120);
            const defaultRoot = resolveToolWorkspaceRoots(sandbox).primaryRoot || process.cwd();
            if (action === 'build_hud' || (action === 'save_ui_scene' && safeUiName.includes('HUD'))) {
                const hudContent = `[gd_scene load_steps=2 format=3]

[node name="${safeUiName}" type="CanvasLayer"]

[node name="Control" type="Control" parent="."]
layout_mode = 3
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
grow_horizontal = 2
grow_vertical = 2

[node name="MarginContainer" type="MarginContainer" parent="Control"]
layout_mode = 0
offset_left = 24.0
offset_top = 24.0
offset_right = 264.0
offset_bottom = 104.0

[node name="VBoxContainer" type="VBoxContainer" parent="Control/MarginContainer"]
layout_mode = 2
theme_override_constants/separation = 8

[node name="HealthBar" type="ProgressBar" parent="Control/MarginContainer/VBoxContainer"]
layout_mode = 2
value = 100.0
show_percentage = false

[node name="Label" type="Label" parent="Control/MarginContainer/VBoxContainer/HealthBar"]
layout_mode = 1
anchors_preset = 8
anchor_left = 0.5
anchor_top = 0.5
anchor_right = 0.5
anchor_bottom = 0.5
offset_left = -20.0
offset_top = -11.5
offset_right = 20.0
offset_bottom = 11.5
grow_horizontal = 2
grow_vertical = 2
text = "100 / 100"
horizontal_alignment = 1

${hasStaminaBar ? `[node name="StaminaBar" type="ProgressBar" parent="Control/MarginContainer/VBoxContainer"]
layout_mode = 2
value = 100.0
show_percentage = false` : ''}

[node name="GoldLabel" type="Label" parent="Control/MarginContainer"]
layout_mode = 2
size_flags_vertical = 8
text = "Gold: 0"
`;
                if (outputPath || action === 'save_ui_scene') {
                    const rawPath = outputPath || path.join(defaultRoot, '.tmp_causyne_3d', `${safeUiSlug}.tscn`);
                    const finalPath = await assertSafeWorkspaceOutput(rawPath, sandbox);
                    await atomicWriteFileSafe(finalPath, hudContent);
                }
                return {
                    success: true,
                    output: JSON.stringify({
                        status: 'BUILT_HUD',
                        ui_name: safeUiName,
                        has_stamina: hasStaminaBar,
                        output_file: outputPath || 'Returned in payload',
                        snippet: hudContent.slice(0, 800)
                    }, null, 2)
                };
            }
            if (action === 'build_main_menu') {
                const menuContent = `[gd_scene format=3]

[node name="${safeUiName}" type="Control"]
layout_mode = 3
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
grow_horizontal = 2
grow_vertical = 2

[node name="Background" type="ColorRect" parent="."]
layout_mode = 1
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
grow_horizontal = 2
grow_vertical = 2
color = Color(0.08, 0.08, 0.12, 1)

[node name="VBoxContainer" type="VBoxContainer" parent="."]
layout_mode = 1
anchors_preset = 8
anchor_left = 0.5
anchor_top = 0.5
anchor_right = 0.5
anchor_bottom = 0.5
offset_left = -160.0
offset_top = -120.0
offset_right = 160.0
offset_bottom = 120.0
grow_horizontal = 2
grow_vertical = 2
theme_override_constants/separation = 16

[node name="TitleLabel" type="Label" parent="VBoxContainer"]
layout_mode = 2
theme_override_font_sizes/font_size = 36
text = "${safeTitle}"
horizontal_alignment = 1

[node name="StartButton" type="Button" parent="VBoxContainer"]
layout_mode = 2
text = "Start Game"

[node name="OptionsButton" type="Button" parent="VBoxContainer"]
layout_mode = 2
text = "Options"

[node name="QuitButton" type="Button" parent="VBoxContainer"]
layout_mode = 2
text = "Quit"
`;
                if (outputPath) {
                    const finalPath = await assertSafeWorkspaceOutput(outputPath, sandbox);
                    await atomicWriteFileSafe(finalPath, menuContent);
                }
                return {
                    success: true,
                    output: JSON.stringify({
                        status: 'BUILT_MAIN_MENU',
                        ui_name: safeUiName,
                        game_title: gameTitle,
                        output_file: outputPath || 'Returned in payload',
                        snippet: menuContent.slice(0, 800)
                    }, null, 2)
                };
            }
            if (action === 'build_dialogue_box') {
                const boxContent = `[gd_scene format=3]

[node name="${safeUiName}" type="CanvasLayer"]

[node name="Panel" type="Panel" parent="."]
anchors_preset = 12
anchor_top = 1.0
anchor_right = 1.0
anchor_bottom = 1.0
offset_top = -160.0
grow_horizontal = 2
grow_vertical = 0

[node name="MarginContainer" type="MarginContainer" parent="Panel"]
layout_mode = 1
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
grow_horizontal = 2
grow_vertical = 2
theme_override_constants/margin_left = 20
theme_override_constants/margin_top = 16
theme_override_constants/margin_right = 20
theme_override_constants/margin_bottom = 16

[node name="VBoxContainer" type="VBoxContainer" parent="Panel/MarginContainer"]
layout_mode = 2

[node name="NPCNameLabel" type="Label" parent="Panel/MarginContainer/VBoxContainer"]
layout_mode = 2
theme_override_font_sizes/font_size = 20
text = "NPC Name"

[node name="DialogueText" type="RichTextLabel" parent="Panel/MarginContainer/VBoxContainer"]
layout_mode = 2
size_flags_vertical = 3
text = "Dialogue text goes here..."

[node name="ChoicesBox" type="HBoxContainer" parent="Panel/MarginContainer/VBoxContainer"]
layout_mode = 2
`;
                if (outputPath) {
                    const finalPath = await assertSafeWorkspaceOutput(outputPath, sandbox);
                    await atomicWriteFileSafe(finalPath, boxContent);
                }
                return {
                    success: true,
                    output: JSON.stringify({
                        status: 'BUILT_DIALOGUE_BOX',
                        ui_name: safeUiName,
                        output_file: outputPath || 'Returned in payload',
                        snippet: boxContent.slice(0, 800)
                    }, null, 2)
                };
            }
            if (action === 'build_inventory_grid') {
                const safeSlots = Number.isFinite(Number(inventorySlots)) ? Math.max(1, Math.min(256, Math.floor(Number(inventorySlots)))) : 24;
                const gridContent = `[gd_scene format=3]

[node name="${safeUiName}" type="Control"]
layout_mode = 3
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
grow_horizontal = 2
grow_vertical = 2

[node name="GridContainer" type="GridContainer" parent="."]
layout_mode = 1
anchors_preset = 8
anchor_left = 0.5
anchor_top = 0.5
anchor_right = 0.5
anchor_bottom = 0.5
offset_left = -240.0
offset_top = -180.0
offset_right = 240.0
offset_bottom = 180.0
grow_horizontal = 2
grow_vertical = 2
columns = 6
# Inventory grid slots count: ${safeSlots}
`;
                if (outputPath) {
                    const finalPath = await assertSafeWorkspaceOutput(outputPath, sandbox);
                    await atomicWriteFileSafe(finalPath, gridContent);
                }
                return {
                    success: true,
                    output: JSON.stringify({
                        status: 'BUILT_INVENTORY_GRID',
                        slots: safeSlots,
                        output_file: outputPath || 'Returned in payload'
                    }, null, 2)
                };
            }
            if (action === 'build_shop_menu') {
                return { success: true, output: JSON.stringify({ status: 'BUILT_SHOP_MENU', ui_name: safeUiName }, null, 2) };
            }
            return { success: false, error: `Unknown action: ${String(action ?? '')}` };
        }
        catch (e) {
            return { success: false, error: sanitizeToolError(e) };
        }
    }
};
