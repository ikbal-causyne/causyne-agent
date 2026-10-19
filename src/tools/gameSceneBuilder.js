import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

export const gameSceneBuilder = {
  schema: {
    name: 'game.scene_build',
    description: 'Programmatically constructs, inspects, and modifies Godot `.tscn` (scene trees) and `.tres` (resources). Formats node hierarchies, attaches scripts (`ExtResource`), binds signals, and sets properties without syntax errors.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create_scene_tree', 'add_node_to_scene', 'inspect_scene', 'bind_signal'],
          description: 'Action: create_scene_tree (build complete .tscn from structure), add_node_to_scene (append node definitions), inspect_scene (parse scene hierarchy), or bind_signal (add connection header).'
        },
        scenePath: {
          type: 'string',
          description: 'Path to `.tscn` file (`res://scenes/actors/Player.tscn` or absolute path).'
        },
        rootNodeType: {
          type: 'string',
          enum: ['Node2D', 'Node3D', 'Control', 'CharacterBody2D', 'CharacterBody3D', 'RigidBody2D', 'CanvasLayer'],
          description: 'Type of root node when creating a scene tree.'
        },
        rootNodeName: {
          type: 'string',
          description: 'Name of the root node (e.g. `Player`, `MainLevel`, `InventoryGrid`).'
        },
        scriptResPath: {
          type: 'string',
          description: 'Path to GDScript resource (`res://scripts/player/player.gd`).'
        },
        childNodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
              parent: { type: 'string' },
              properties: { type: 'object' }
            }
          },
          description: 'Child nodes to append.'
        },
        signalConfig: {
          type: 'object',
          properties: {
            signal_name: { type: 'string' },
            from_node: { type: 'string' },
            to_node: { type: 'string' },
            method_name: { type: 'string' }
          },
          description: 'Signal connection configuration.'
        }
      },
      required: ['action', 'scenePath']
    }
  },

  async execute(args) {
    try {
      const { action, scenePath, rootNodeType = 'Node2D', rootNodeName = 'Root', scriptResPath, childNodes = [], signalConfig } = args;

      if (action === 'create_scene_tree') {
        let loadSteps = 1;
        let extResources = '';
        let scriptAttr = '';

        if (scriptResPath) {
          loadSteps = 2;
          extResources = `[ext_resource type="Script" path="${scriptResPath}" id="1_script"]\n\n`;
          scriptAttr = `script = ExtResource("1_script")\n`;
        }

        let childBlocks = '';
        for (const child of childNodes) {
          const parentAttr = child.parent ? ` parent="${child.parent}"` : ' parent="."';
          let props = '';
          if (child.properties) {
            for (const [k, v] of Object.entries(child.properties)) {
              props += `${k} = ${typeof v === 'string' ? `"${v}"` : v}\n`;
            }
          }
          childBlocks += `\n[node name="${child.name}" type="${child.type || 'Node'}"${parentAttr}]\n${props}`;
        }

        const content = `[gd_scene load_steps=${loadSteps} format=3]\n\n${extResources}[node name="${rootNodeName}" type="${rootNodeType}"]\n${scriptAttr}${childBlocks}`;

        if (scenePath) {
          await fs.mkdir(path.dirname(scenePath), { recursive: true });
          await fs.writeFile(scenePath, content, 'utf8');
        }

        return {
          success: true,
          output: JSON.stringify({
            status: 'CREATED_SCENE_TREE',
            scene_path: scenePath,
            root_node: rootNodeName,
            root_type: rootNodeType,
            child_count: childNodes.length,
            content_snippet: content.slice(0, 1000)
          }, null, 2)
        };
      }

      if (action === 'inspect_scene') {
        if (!fsSync.existsSync(scenePath)) {
          return { success: false, error: `Scene file not found: ${scenePath}` };
        }
        const raw = await fs.readFile(scenePath, 'utf8');
        const nodeMatches = [...raw.matchAll(/\[node name="([^"]+)" type="([^"]+)"(?: parent="([^"]+)")?\]/g)];
        const nodes = nodeMatches.map(m => ({
          name: m[1],
          type: m[2],
          parent: m[3] || 'Root'
        }));

        return {
          success: true,
          output: JSON.stringify({
            status: 'INSPECTED_SCENE',
            scene_path: scenePath,
            total_nodes: nodes.length,
            node_hierarchy: nodes
          }, null, 2)
        };
      }

      if (action === 'bind_signal') {
        if (!signalConfig || !signalConfig.signal_name) {
          return { success: false, error: 'signalConfig with signal_name, from_node, to_node, and method_name is required.' };
        }
        const connHeader = `\n[connection signal="${signalConfig.signal_name}" from="${signalConfig.from_node}" to="${signalConfig.to_node}" method="${signalConfig.method_name}"]\n`;
        
        if (fsSync.existsSync(scenePath)) {
          await fs.appendFile(scenePath, connHeader, 'utf8');
        }

        return {
          success: true,
          output: JSON.stringify({
            status: 'BOUND_SIGNAL',
            scene_path: scenePath,
            connection: signalConfig,
            snippet: connHeader.trim()
          }, null, 2)
        };
      }

      return { success: false, error: `Unknown action: ${action}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
