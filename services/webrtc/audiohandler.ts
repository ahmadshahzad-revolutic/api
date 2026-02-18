// Calculate volume in dB from u-law audio buffer
export function calculateDb(buffer: Buffer): number {
    let sumSquares = 0;
    for (let i = 0; i < buffer.length; i++) {
        let u = ~buffer[i];
        let sign = (u & 0x80);
        let exponent = (u & 0x70) >> 4;
        let mantissa = (u & 0x0F);
        let sample = (mantissa << 3) + 132;
        sample <<= (exponent);
        sample -= 132;
        const normalized = (sign ? -sample : sample) / 32768.0;
        sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / buffer.length);
    return 20 * Math.log10(Math.max(rms, 0.00001));
}
