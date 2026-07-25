import crypto from 'crypto';

export function generateWorkerId() {
  return `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
}