#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { HandBrakeService } from '../src/services/handbrake.service.js';
import { Logger } from '../src/utils/logger.js';

async function main() {
  const folderArg = process.argv[2] || 'media/ALADDIN';
  const folder = path.resolve(process.cwd(), folderArg);

  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    console.error(`Folder not found: ${folder}`);
    process.exit(2);
  }

  const files = fs.readdirSync(folder).filter(f => f.toLowerCase().endsWith('.mkv'));
  if (files.length === 0) {
    console.log(`No MKV files found in ${folder}`);
    return;
  }

  for (const file of files) {
    const inputPath = path.join(folder, file);
    console.log(`Converting: ${inputPath}`);
    try {
      const success = await HandBrakeService.convertFile(inputPath);
      if (success) {
        console.log(`Success: ${file}`);
      } else {
        console.error(`Failed: ${file}`);
      }
    } catch (err) {
      console.error(`Error converting ${file}: ${err.message || err}`);
      Logger.error(err);
    }
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
