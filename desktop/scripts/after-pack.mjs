import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const UNUSED_PERMISSION_KEYS = [
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
];

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const plistPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Info.plist');
  await execFileAsync('/usr/libexec/PlistBuddy', [
    '-c',
    'Set :NSAppTransportSecurity:NSAllowsArbitraryLoads false',
    plistPath,
  ]);
  for (const key of UNUSED_PERMISSION_KEYS) {
    try {
      await execFileAsync('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, plistPath]);
    } catch (error) {
      const message = String(error?.stderr || error?.message || '');
      if (!message.includes('Does Not Exist')) throw error;
    }
  }
}
