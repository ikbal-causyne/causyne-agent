import fs from 'fs/promises';
import path from 'path';

export const todoWrite = {
  schema: {
    name: 'TodoWrite',
    description: 'Dynamic Context Injector: Create and manage structured tasks. Forces atomic, granular steps instead of vague goals.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The updated todo list (JSON state)',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              content: { type: 'string', minLength: 5, description: 'Must be an atomic, actionable step.' },
              status: { 
                type: 'string',
                enum: ['pending', 'in_progress', 'completed']
              }
            },
            required: ['id', 'content', 'status'],
            additionalProperties: false
          }
        }
      },
      required: ['todos'],
      additionalProperties: false
    }
  },
  async execute(args) {
    try {
      const todoPath = path.join(process.cwd(), '.causyne_todos.json');
      const mdPath = path.join(process.cwd(), 'AGI_PLAN.md');
      
      // Phase 2 AGI Upgrade: Atomic Validation
      for (const task of args.todos) {
        const words = task.content.split(' ').length;
        if (words < 2) {
          return { success: false, error: `Task [${task.id}] is too vague ("${task.content}"). Rewrite it into an atomic, actionable step (e.g., "Scaffold React Navbar").` };
        }
      }
      
      // Save JSON state
      await fs.writeFile(todoPath, JSON.stringify(args.todos, null, 2), 'utf8');
      
      // Render to MD for user visibility
      let mdContent = '# AGI Execution Plan\n\n';
      for (const t of args.todos) {
        let box = '[ ]';
        if (t.status === 'in_progress') box = '[/]';
        if (t.status === 'completed') box = '[x]';
        mdContent += `- ${box} ${t.id}: ${t.content}\n`;
      }
      await fs.writeFile(mdPath, mdContent, 'utf8');
      
      // Phase 2 AGI Upgrade: Memory Hook (Signaling back to AgentLoop context window)
      const inProgress = args.todos.filter(t => t.status === 'in_progress');
      const completed = args.todos.filter(t => t.status === 'completed');
      
      if (inProgress.length > 1) {
        return { success: true, output: `[Memory Hook] Saved. WARNING: You have ${inProgress.length} tasks in_progress. Only ONE task may be in progress at a time.` };
      }
      
      return { 
        success: true, 
        output: `[Memory Hook] Tasks synchronized. ${completed.length} completed, ${inProgress.length} active. Focus locked on: ${inProgress[0]?.content || 'None'}` 
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
