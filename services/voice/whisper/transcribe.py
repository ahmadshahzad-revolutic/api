import sys
import json
import os
from faster_whisper import WhisperModel

# Prevent logging clutter
import logging
logging.basicConfig()
logging.getLogger("faster_whisper").setLevel(logging.ERROR)

import wave
try:
    import audioop
except ImportError:
    import audioop_lts as audioop

# Load model
# Use 'tiny' for speed/low memory on CPU
model_size = os.getenv("WHISPER_MODEL_SIZE", "tiny")
device = "cpu"
compute_type = "int8" # Low CPU usage

try:
    model = WhisperModel(model_size, device=device, compute_type=compute_type)
except Exception as e:
    print(json.dumps({"error": f"Failed to load model: {str(e)}"}))
    sys.exit(1)

def transcribe(audio_file, language=None):
    if not os.path.exists(audio_file):
        return json.dumps({"error": f"File not found: {audio_file}"})
        
    try:
        # Check if it's a raw file (we assume raw u-law 8kHz for our context)
        with open(audio_file, "rb") as f:
            raw_data = f.read()
        
        # Decode u-law to PCM (16-bit)
        pcm_data = audioop.ulaw2lin(raw_data, 2)

        # Check for silence/low volume to avoid hallucinations
        peak = audioop.max(pcm_data, 2)
        if peak < 100: # Very low threshold for silence
            return json.dumps({
                "language": language or "auto",
                "text": "",
                "status": "success",
                "silence": True
            })

        # Resample from 8kHz to 16kHz
        pcm_16k, _ = audioop.ratecv(pcm_data, 2, 1, 8000, 16000, None)
        
        temp_wav = audio_file + ".wav"
        with wave.open(temp_wav, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(16000)
            wav_file.writeframes(pcm_16k)
            
        # If language is 'auto', we pass None to let whisper detect
        lang_param = None if not language or language == 'auto' else language
        segments, info = model.transcribe(temp_wav, beam_size=5, language=lang_param)
        
        lang = info.language
        text = ""
        for segment in segments:
            text += segment.text + " "
        
        if os.path.exists(temp_wav):
            os.remove(temp_wav)
            
        return json.dumps({
            "language": lang, 
            "text": text.strip(),
            "status": "success"
        })
    except Exception as e:
        if 'temp_wav' in locals() and os.path.exists(temp_wav):
            os.remove(temp_wav)
        return json.dumps({"error": str(e), "status": "error"})

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No audio file provided"}))
        sys.exit(1)
        
    audio_path = sys.argv[1]
    language = sys.argv[2] if len(sys.argv) > 2 else None
    print(transcribe(audio_path, language))
