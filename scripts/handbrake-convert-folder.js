#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { HandBrakeService } from '../src/services/handbrake.service.js';
import { Logger } from '../src/utils/logger.js';

const DEFAULT_CPU_PERCENT = 75;

const USAGE = `Usage: node scripts/handbrake-convert-folder.js [folder] [--cpu-percent=N]

  folder           Folder of MKV files to convert (default: media/ALADDIN)
  --cpu-percent=N  Percentage of logical cores each encode may use, 1-100
                   (default: ${DEFAULT_CPU_PERCENT}). Overrides handbrake.cpu_percent
                   in config.yaml for this run only.
  -h, --help       Show this message`;

/**
 * @param {string[]} argv - Arguments after the script name
 * @returns {{folder: string, cpuPercent: number, help: boolean}}
 * @throws {Error} If an argument is unrecognised or out of range
 */
export function parseArgs(argv) {
  let folder = null;
  let cpuPercent = DEFAULT_CPU_PERCENT;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }

    if (arg === '--cpu-percent' || arg === '-c') {
      cpuPercent = parseCpuPercent(argv[++i]);
      continue;
    }

    if (arg.startsWith('--cpu-percent=')) {
      cpuPercent = parseCpuPercent(arg.slice('--cpu-percent='.length));
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (folder !== null) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
    folder = arg;
  }

  return { folder: folder || 'media/ALADDIN', cpuPercent, help };
}

function parseCpuPercent(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1 || value > 100) {
    throw new Error(`--cpu-percent must be a number between 1 and 100 (got: ${raw})`);
  }
  return value;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    process.exit(2);
  }

  if (options.help) {
    console.log(USAGE);
    return;
  }

  const folder = path.resolve(process.cwd(), options.folder);

  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    console.error(`Folder not found: ${folder}`);
    process.exit(2);
  }

  const files = fs.readdirSync(folder).filter(f => f.toLowerCase().endsWith('.mkv'));
  if (files.length === 0) {
    console.log(`No MKV files found in ${folder}`);
    return;
  }

  const totalCores = HandBrakeService.getAvailableCpuCount();
  const threads = HandBrakeService.getConfiguredThreadCount(options.cpuPercent);
  console.log(
    `CPU allocation: ${options.cpuPercent}% of ${totalCores} logical cores -> ${threads} encoder threads`
  );

  for (const file of files) {
    const inputPath = path.join(folder, file);
    console.log(`Converting: ${inputPath}`);
    try {
      const success = await HandBrakeService.convertFile(inputPath, {
        cpuPercent: options.cpuPercent,
      });
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
