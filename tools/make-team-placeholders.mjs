/**
 * Generates branded placeholder headshots for the team, so the photo files
 * always exist (no 404 probing) until real photos replace them. Rerun after
 * adding a team member: node tools/make-team-placeholders.mjs [--force]
 */
import sharp from 'sharp';
import { existsSync } from 'node:fs';

const TEAM = [
  { file: 'assets/img/team/anthony.jpg', initials: 'AE' },
  { file: 'assets/img/team/megan.jpg', initials: 'M' }
];
const force = process.argv.includes('--force');

for (const t of TEAM) {
  if (existsSync(t.file) && !force) { console.log('kept', t.file); continue; }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
    <rect width="400" height="400" fill="#0b2a3c"/>
    <circle cx="200" cy="200" r="186" fill="none" stroke="#2bb3e8" stroke-width="14"/>
    <text x="200" y="238" text-anchor="middle" font-family="Arial, Helvetica, sans-serif"
      font-size="128" font-weight="700" fill="#ffffff" letter-spacing="4">${t.initials}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toFile(t.file);
  console.log('generated', t.file);
}
