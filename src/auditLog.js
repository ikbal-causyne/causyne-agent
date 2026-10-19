import fs from 'fs';
import path from 'path';
import os from 'os';
import { causyneHome } from './utils/paths.js';

const LOG_DIR = path.join(causyneHome(), 'logs');

export class AuditLog {
  constructor() {
    this.ensureLogDir();
    const date = new Date().toISOString().split('T')[0];
    this.logFile = path.join(LOG_DIR, `audit-${date}.jsonl`);
  }

  ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
  }

  log(eventData) {
    const entry = {
      ts: new Date().toISOString(),
      ...eventData
    };
    
    // Append to file synchronously to ensure it writes before any potential crash
    try {
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
    } catch (e) {
      console.error('Failed to write audit log:', e);
    }
  }

  getRecentLogs(limit = 100) {
    if (!fs.existsSync(this.logFile)) return [];
    
    try {
      const content = fs.readFileSync(this.logFile, 'utf8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      
      return lines.slice(-limit).map(l => {
        try { return JSON.parse(l); } catch(e) { return null; }
      }).filter(Boolean);
    } catch (e) {
      console.error('Failed to read audit log:', e);
      return [];
    }
  }
}

export const auditLog = new AuditLog();
