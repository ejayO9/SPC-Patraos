import json
import numpy as np
import librosa
import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List, Optional
import soundfile as sf
import io
import base64
import logging
from fastapi import HTTPException
from livekit_token_generator import generate_livekit_token
import os

# Configure logging
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = FastAPI()

# Global variable to store the latest analysis data
latest_analyzed_sections: Optional[List[dict]] = None

logger.info("Starting ai singing assistant API")

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # React dev server
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load reference pitch data
with open('reference_pitch.json', 'r') as f:
    reference_pitch_data = json.load(f)

# Audio processing parameters
SAMPLE_RATE = 44100       # CD-quality audio sampling rate
FRAME_LENGTH = 2048       # Window size for pitch analysis
HOP_LENGTH = 512         # Step size between analysis windows
FMIN = librosa.note_to_hz('C2')  # Minimum frequency (~65 Hz)
FMAX = librosa.note_to_hz('C7')  # Maximum frequency (~2093 Hz)

class PitchPoint(BaseModel):
    timestamp: float
    pitch: Optional[float]

class PitchComparison(BaseModel):
    timestamp: float
    reference_pitch: Optional[float]
    user_pitch: Optional[float]
    deviation_percentage: Optional[float]

class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def send_personal_message(self, message: str, websocket: WebSocket):
        await websocket.send_text(message)

    async def broadcast(self, message: str):
        for connection in self.active_connections:
            await connection.send_text(message)

manager = ConnectionManager()

def detect_pitch_from_audio(audio_data: np.ndarray, sr: int = SAMPLE_RATE) -> List[PitchPoint]:
    """Detect pitch from audio data using pYIN algorithm"""
    try:
        # Ensure audio is mono
        if len(audio_data.shape) > 1:
            audio_data = np.mean(audio_data, axis=1)
        
        # Detect pitch using pYIN
        f0, voiced_flag, voiced_probs = librosa.pyin(
            audio_data,
            fmin=FMIN,
            fmax=FMAX,
            sr=sr,
            frame_length=FRAME_LENGTH,
            hop_length=HOP_LENGTH
        )
        
        # Generate timestamps
        times = librosa.times_like(f0, sr=sr, hop_length=HOP_LENGTH)
        
        # Create pitch data
        pitch_data = []
        for t, pitch in zip(times, f0):
            # Cap pitch at 350 Hz if it exceeds that value
            if not np.isnan(pitch) and pitch > 350:
                pitch = 350.0
            
            pitch_data.append({
                "timestamp": float(t),
                "pitch": float(pitch) if not np.isnan(pitch) else None
            })
        
        return pitch_data
    except Exception as e:
        print(f"Error detecting pitch: {e}")
        return []

def compare_pitches(reference: List[dict], user: List[dict], time_offset: float = 0) -> List[PitchComparison]:
    """Compare user pitch with reference pitch
        args :
            reference : its the pitch data of the reference audio 
            user : its the pitch data of the user audio which is chunked into x second intervals
            time_offset : its the time offset of the user audio. for example if the current chunk of user audio is 10 seconds into the song, then the time_offset is 10
    """
    comparisons = []
    
    # Create a mapping of reference pitches by timestamp
    ref_map = {point['timestamp']: point['pitch'] for point in reference}
    
    for user_point in user:
        # Adjust user timestamp by offset
        adjusted_timestamp = user_point['timestamp'] + time_offset
        
        # Find closest reference timestamp
        closest_ref_time = min(ref_map.keys(), key=lambda t: abs(t - adjusted_timestamp))
        
        # Only compare if timestamps are close enough (within 50ms)
        if abs(closest_ref_time - adjusted_timestamp) < 0.05:
            ref_pitch = ref_map[closest_ref_time]
            user_pitch = user_point['pitch']
            
            deviation = None
            if ref_pitch is not None and user_pitch is not None and ref_pitch > 0:
                # Calculate percentage deviation
                deviation = abs(user_pitch - ref_pitch) / ref_pitch * 100
            elif ref_pitch is None and user_pitch is not None:
                # User is singing when they shouldn't be (reference is silent)
                deviation = 100.0
            
            comparisons.append({
                "timestamp": adjusted_timestamp,
                "reference_pitch": ref_pitch,
                "user_pitch": user_pitch,
                "deviation_percentage": deviation
            })
    
    return comparisons

def find_problem_sections(comparisons: List[dict], threshold: float = 30.0, problem_duration: int = 0.5) -> List[dict]:
    """Find sections where user's pitch deviates more than threshold percentage
    
        args :
            comparisons : its the return data from the compare_pitches function
            threshold : its the threshold of deviation to consider a section as a problem section to give feedback to the user
    """
    
    problem_sections = []
    current_section = None
    
    for comp in comparisons:
        if comp['deviation_percentage'] is not None and comp['deviation_percentage'] > threshold:
            if current_section is None:
                # Determine direction of deviation
                ref_pitch = comp.get('reference_pitch')
                user_pitch = comp.get('user_pitch')
                if ref_pitch is not None and user_pitch is not None:
                    direction = 'above' if user_pitch > ref_pitch else 'below'
                else:
                    direction = 'unknown'
                # Start a new problem section with direction
                current_section = {
                    'start_time': comp['timestamp'],
                    'end_time': comp['timestamp'],
                    'avg_deviation': comp['deviation_percentage'],
                    'direction': direction
                }
            else:
                # Determine direction for this comparison point
                ref_pitch = comp.get('reference_pitch')
                user_pitch = comp.get('user_pitch')
                if ref_pitch is not None and user_pitch is not None:
                    comp_direction = 'above' if user_pitch > ref_pitch else 'below'
                else:
                    comp_direction = 'unknown'
                if comp_direction == current_section['direction']:
                    # Same direction: extend current section
                    current_section['end_time'] = comp['timestamp']
                    current_section['avg_deviation'] = (
                        current_section['avg_deviation'] + comp['deviation_percentage']
                    ) / 2
                else:
                    # Direction changed: close previous section and start a new one
                    if current_section['end_time'] - current_section['start_time'] > problem_duration:
                        problem_sections.append(current_section)
                    current_section = {
                        'start_time': comp['timestamp'],
                        'end_time': comp['timestamp'],
                        'avg_deviation': comp['deviation_percentage'],
                        'direction': comp_direction
                    }
        else:
            if current_section is not None:
                # Only add sections longer than problem_duration seconds
                if current_section['end_time'] - current_section['start_time'] > problem_duration:
                    problem_sections.append(current_section)
                current_section = None
    
    # Don't forget the last section
    if current_section is not None and current_section['end_time'] - current_section['start_time'] > problem_duration:
        problem_sections.append(current_section)
    
    return problem_sections

@app.get("/")
async def root():
    return {"message": " ai singing assistant API"}

@app.get("/reference-pitch")
async def get_reference_pitch():
    """Get the reference pitch data"""
    return reference_pitch_data

@app.get("/lyrics")
async def get_lyrics():
    """Get the lyrics data with timing information"""
    try:
        # You should replace 'song_lyrics.json' with the actual lyrics file for your song
        with open('song_lyrics.json', 'r', encoding='utf-8') as f:
            lyrics_data = json.load(f)
        return lyrics_data
    except FileNotFoundError:
        # Return example lyrics if the actual file doesn't exist
        with open('example_lyrics.json', 'r', encoding='utf-8') as f:
            lyrics_data = json.load(f)
        return lyrics_data
    except Exception as e:
        logger.error(f"Error loading lyrics: {e}")
        raise HTTPException(status_code=500, detail="Failed to load lyrics")

@app.get("/song/{filename}")
async def get_song(filename: str):
    """Serve the song file"""
    return FileResponse(f"songs/{filename}")

# a post rquest to send the problem sections found by frontend to backend
@app.post("/problem-sections")
async def send_problem_sections(problem_sections: List[dict]):
    """Send problem sections to backend"""
    return {"message": "Problem sections received", "problem_sections": problem_sections}

@app.post("/analyze-performance")
async def analyze_performance_endpoint(problem_sections_payload: List[dict]):
    """Analyzes performance data and returns problem sections."""
    logger.info(f"Received problem sections for analysis: {len(problem_sections_payload)} problem points")

    # Group consecutive problem points into sections
    if not problem_sections_payload:
        return {"message": "No problems found", "analyzed_sections": []}
    
    # Sort by timestamp
    sorted_problems = sorted(problem_sections_payload, key=lambda x: x['timestamp'])
    
    analyzed_sections = []
    current_section = None
    
    for problem in sorted_problems:
        if current_section is None:
            # Start a new section
            ref_pitch = problem.get('reference_pitch')
            user_pitch = problem.get('user_pitch')
            if ref_pitch is not None and user_pitch is not None:
                direction = 'above' if user_pitch > ref_pitch else 'below'
            else:
                direction = 'unknown'
                
            current_section = {
                'start_time': problem['timestamp'],
                'end_time': problem['timestamp'],
                'avg_deviation': problem['deviation_percentage'],
                'direction': direction,
                'count': 1
            }
        else:
            # Check if this is part of the same section (within 0.5 seconds)
            if problem['timestamp'] - current_section['end_time'] <= 0.5:
                # Extend current section
                current_section['end_time'] = problem['timestamp']
                # Calculate running average
                current_section['avg_deviation'] = (
                    (current_section['avg_deviation'] * current_section['count'] + problem['deviation_percentage']) / 
                    (current_section['count'] + 1)
                )
                current_section['count'] += 1
            else:
                # Gap too large, save current section and start new one
                if current_section['end_time'] - current_section['start_time'] >= 0.5:
                    # Only save sections that are at least 0.5 seconds long
                    analyzed_sections.append({
                        'start_time': current_section['start_time'],
                        'end_time': current_section['end_time'],
                        'avg_deviation': current_section['avg_deviation'],
                        'direction': current_section['direction']
                    })
                
                # Start new section
                ref_pitch = problem.get('reference_pitch')
                user_pitch = problem.get('user_pitch')
                if ref_pitch is not None and user_pitch is not None:
                    direction = 'above' if user_pitch > ref_pitch else 'below'
                else:
                    direction = 'unknown'
                    
                current_section = {
                    'start_time': problem['timestamp'],
                    'end_time': problem['timestamp'],
                    'avg_deviation': problem['deviation_percentage'],
                    'direction': direction,
                    'count': 1
                }
    
    # Don't forget the last section
    if current_section and current_section['end_time'] - current_section['start_time'] >= 0.5:
        analyzed_sections.append({
            'start_time': current_section['start_time'],
            'end_time': current_section['end_time'],
            'avg_deviation': current_section['avg_deviation'],
            'direction': current_section['direction']
        })
    
    # Log the results
    logger.info(f"Analyzed performance sections: {len(analyzed_sections)} problem sections found")
    for section in analyzed_sections:
        logger.info(f"  Section: {section['start_time']:.1f}s - {section['end_time']:.1f}s, "
                   f"avg deviation: {section['avg_deviation']:.1f}%, direction: {section['direction']}")
    
    # Store the analyzed sections globally
    global latest_analyzed_sections
    latest_analyzed_sections = analyzed_sections
    
    return {"message": "Performance analyzed", "analyzed_sections": analyzed_sections}

@app.get("/get-latest-analysis")
async def get_latest_analysis_data():
    """Get the latest analyzed performance data"""
    global latest_analyzed_sections
    if latest_analyzed_sections is None:
        raise HTTPException(status_code=404, detail="No analysis data available yet.")
    return {"analyzed_sections": latest_analyzed_sections}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    
    try:
        # Buffer for accumulating audio chunks
        audio_buffer = []
        buffer_duration = 0.5  #chunk size
        samples_per_buffer = int(SAMPLE_RATE * buffer_duration)
        current_time_offset = 0
        
        while True:
            # Receive audio data from client
            data = await websocket.receive_text()
            message = json.loads(data)
            
            if message['type'] == 'audio_chunk':
                # Decode base64 audio data
                audio_bytes = base64.b64decode(message['audio_data'])
                
                # Convert bytes to numpy array (assuming float32 PCM)
                audio_chunk = np.frombuffer(audio_bytes, dtype=np.float32)
                
                # Add to buffer
                audio_buffer.extend(audio_chunk)
                
                # Process when buffer is full
                if len(audio_buffer) >= samples_per_buffer:
                    # Convert to numpy array
                    audio_data = np.array(audio_buffer[:samples_per_buffer])
                    
                    # Detect pitch
                    user_pitch = detect_pitch_from_audio(audio_data)
                    
                    # Compare with reference
                    comparisons = compare_pitches(
                        reference_pitch_data, 
                        user_pitch, 
                        current_time_offset
                    )
                    
                    # Send results back to client
                    await websocket.send_text(json.dumps({
                        'type': 'pitch_update',
                        'user_pitch': user_pitch,
                        'comparisons': comparisons,
                        'time_offset': current_time_offset
                    }))
                    
                    # Update time offset
                    current_time_offset += buffer_duration
                    
                    # Keep remaining samples in buffer
                    audio_buffer = audio_buffer[samples_per_buffer:]
            
            elif message['type'] == 'song_position':
                # Update current position in song
                current_time_offset = message['position']
            
            elif message['type'] == 'end_performance':
                # Analyze entire performance
                # (In a real app, you'd accumulate all comparisons and analyze them)
                await websocket.send_text(json.dumps({
                    'type': 'performance_complete',
                    'message': 'Performance analysis complete'
                }))
                
    except WebSocketDisconnect:
        manager.disconnect(websocket)
        print("Client disconnected")
    except Exception as e:
        print(f"WebSocket error: {e}")
        manager.disconnect(websocket)

class TokenRequest(BaseModel):
    room_name: str = "avatar-room"
    participant_name: str = "user"

@app.post("/generate-livekit-token")
async def generate_token(request: TokenRequest):
    try:
        # Just generate the token without trying to create the room
        # The agent will handle room creation/joining when it connects
        token = generate_livekit_token(
            room_name=request.room_name,
            participant_name=request.participant_name
        )
        logger.info(f"Generated token for room: {request.room_name}, participant: {request.participant_name}")
        return {"token": token}
    except Exception as e:
        logger.error(f"Error generating token: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)