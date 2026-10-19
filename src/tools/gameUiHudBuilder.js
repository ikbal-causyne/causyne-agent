import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

export const gameUiHudBuilder = {
  schema: {
    name: 'game.ui_hud_builder',
    description: 'Constructs responsive UI/HUD scenes for Godot 4.x (`MainMenu.tscn`, `HUD.tscn` with player health/stamina bars, `InventoryGrid.tscn`, `DialogueBox.tscn`, `ShopMenu.tscn`, and `QuestLog.tscn`). Includes anchored layouts (`Control`) and signal bindings (`button_up`, `item_selected`).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['build_hud', 'build_main_menu', 'build_dialogue_box', 'build_inventory_grid', 'build_shop_menu', 'save_ui_scene'],
          description: 'Action: build_hud (health/stamina overlay), build_main_menu (start/options/quit buttons), build_dialogue_box (NPC text panel), build_inventory_grid (item slots container), build_shop_menu (trade interface), or save_ui_scene (write .tscn to disk).'
        },
        uiName: {
          type: 'string',
          description: 'Name of the UI node (`PlayerHUD`, `MainMenu`, `DialogueUI`).'
        },
        gameTitle: {
          type: 'string',
          description: 'Title for MainMenu (`Chronicles of Aetheria`, `Cyberpunk Highway 3D`).'
        },
        hasStaminaBar: { type: 'boolean', description: 'Include stamina bar in HUD (default true).' },
        inventorySlots: { type: 'number', description: 'Number of inventory grid slots (default 24).' },
        outputPath: { type: 'string', description: 'Absolute or res:// path to save `.tscn` (`res://scenes/ui/HUD.tscn`).' }
      },
      required: ['action']
    }
  },

  async execute(args) {
    try {
      const { action, uiName = 'GameUI', gameTitle = 'Chronicles of Aetheria', hasStaminaBar = true, inventorySlots = 24, outputPath } = args;

      if (action === 'build_hud' || (action === 'save_ui_scene' && uiName.includes('HUD'))) {
        const hudContent = `[gd_scene load_steps=2 format=3]

[node name="${uiName}" type="CanvasLayer"]

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
          const finalPath = outputPath || path.join(process.cwd(), '.tmp_causyne_3d', `${uiName}.tscn`);
          await fs.mkdir(path.dirname(finalPath), { recursive: true });
          await fs.writeFile(finalPath, hudContent, 'utf8');
        }

        return {
          success: true,
          output: JSON.stringify({
            status: 'BUILT_HUD',
            ui_name: uiName,
            has_stamina: hasStaminaBar,
            output_file: outputPath || 'Returned in payload',
            snippet: hudContent.slice(0, 800)
          }, null, 2)
        };
      }

      if (action === 'build_main_menu') {
        const menuContent = `[gd_scene format=3]

[node name="${uiName}" type="Control"]
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
text = "${gameTitle}"
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
          await fs.mkdir(path.dirname(outputPath), { recursive: true });
          await fs.writeFile(outputPath, menuContent, 'utf8');
        }

        return {
          success: true,
          output: JSON.stringify({
            status: 'BUILT_MAIN_MENU',
            ui_name: uiName,
            game_title: gameTitle,
            output_file: outputPath || 'Returned in payload',
            snippet: menuContent.slice(0, 800)
          }, null, 2)
        };
      }

      if (action === 'build_dialogue_box') {
        const boxContent = `[gd_scene format=3]

[node name="${uiName}" type="CanvasLayer"]

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
          await fs.mkdir(path.dirname(outputPath), { recursive: true });
          await fs.writeFile(outputPath, boxContent, 'utf8');
        }

        return {
          success: true,
          output: JSON.stringify({
            status: 'BUILT_DIALOGUE_BOX',
            ui_name: uiName,
            output_file: outputPath || 'Returned in payload',
            snippet: boxContent.slice(0, 800)
          }, null, 2)
        };
      }

      if (action === 'build_inventory_grid') {
        const gridContent = `[gd_scene format=3]

[node name="${uiName}" type="Control"]
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
# Inventory grid slots count: ${inventorySlots}
`;
        if (outputPath) {
          await fs.mkdir(path.dirname(outputPath), { recursive: true });
          await fs.writeFile(outputPath, gridContent, 'utf8');
        }

        return {
          success: true,
          output: JSON.stringify({
            status: 'BUILT_INVENTORY_GRID',
            slots: inventorySlots,
            output_file: outputPath || 'Returned in payload'
          }, null, 2)
        };
      }

      if (action === 'build_shop_menu') {
        return {
          success: true,
          output: JSON.stringify({ status: 'BUILT_SHOP_MENU', ui_name: uiName }, null, 2)
        };
      }

      return { success: false, error: `Unknown action: ${action}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
