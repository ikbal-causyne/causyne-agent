import fs from 'fs';
import path from 'path';

export const updatePlan = {
  schema: {
    name: 'update_plan',
    description: 'Self-Correcting Trajectory Engine: Update specific tasks in your plan using delta operations without rewriting everything.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'ADD_TASK', 'REMOVE_TASK', 'MARK_COMPLETED', 'MARK_FAILED']
        },
        taskId: { type: 'string', description: 'ID of the task to modify' },
        taskContent: { type: 'string', description: 'Content of the new task (if ADD_TASK)' },
        failureReason: { type: 'string', description: 'REQUIRED if action is MARK_FAILED' }
      },
      required: ['action']
    }
  },
  
  execute: async (args) => {
    try {
      const todoPath = path.resolve(process.cwd(), '.causyne_todos.json');
      const mdPath = path.resolve(process.cwd(), 'AGI_PLAN.md');
      
      let todos = [];
      if (fs.existsSync(todoPath)) {
        todos = JSON.parse(fs.readFileSync(todoPath, 'utf8'));
      }
      
      if (args.action === 'read') {
        if (!fs.existsSync(mdPath)) return "No plan exists.";
        return fs.readFileSync(mdPath, 'utf8');
      }
      
      if (args.action === 'MARK_FAILED' && !args.failureReason) {
        return "Error: You MUST provide a failureReason when marking a task as failed.";
      }

      if (args.action === 'ADD_TASK') {
        if (!args.taskId || !args.taskContent) return "Missing taskId or taskContent";
        todos.push({ id: args.taskId, content: args.taskContent, status: 'pending' });
      } 
      else if (args.action === 'REMOVE_TASK') {
        todos = todos.filter(t => t.id !== args.taskId);
      }
      else if (args.action === 'MARK_COMPLETED') {
        const t = todos.find(t => t.id === args.taskId);
        if (t) t.status = 'completed';
      }
      else if (args.action === 'MARK_FAILED') {
        const t = todos.find(t => t.id === args.taskId);
        if (t) {
          t.status = 'pending'; // Reset it
          // Phase 2 AGI Upgrade: Auto-Pivot
          todos.push({ 
            id: `investigate_${args.taskId}`, 
            content: `Investigate failure of ${args.taskId}: ${args.failureReason}`, 
            status: 'in_progress' 
          });
        }
      }

      // Sync JSON
      fs.writeFileSync(todoPath, JSON.stringify(todos, null, 2), 'utf8');
      
      // Sync MD
      let mdContent = '# AGI Execution Plan\n\n';
      for (const t of todos) {
        let box = '[ ]';
        if (t.status === 'in_progress') box = '[/]';
        if (t.status === 'completed') box = '[x]';
        mdContent += `- ${box} ${t.id}: ${t.content}\n`;
      }
      fs.writeFileSync(mdPath, mdContent, 'utf8');
      
      if (args.action === 'MARK_FAILED') {
        return `Task failed. Auto-pivot engaged. Added investigation task.`;
      }

      return "Plan delta updated successfully.";
    } catch (error) {
      return `Error updating plan: ${error.message}`;
    }
  }
};
