import React, { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';
import axios from 'axios';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import AvatarAgent from './AvatarAgent';

const BACKEND_URL = 'http://localhost:8000';
const WS_URL = 'ws://localhost:8000/ws';

// LiveKit configuration - replace with your actual values
const LIVEKIT_SERVER_URL = process.env.REACT_APP_LIVEKIT_SERVER_URL || 'wss://your-livekit-server.com';
const LIVEKIT_API_KEY = process.env.REACT_APP_LIVEKIT_API_KEY || 'your-api-key';
const LIVEKIT_API_SECRET = process.env.REACT_APP_LIVEKIT_API_SECRET || 'your-api-secret';

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [referencePitch, setReferencePitch] = useState([]);
  const [userPitchData, setUserPitchData] = useState([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [problemSections, setProblemSections] = useState([]);
  const [performanceComplete, setPerformanceComplete] = useState(false);
  const [liveKitToken, setLiveKitToken] = useState(null);
  const [showAvatar, setShowAvatar] = useState(false);
  
  const audioRef = useRef(null);
  const audioContextRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const processorRef = useRef(null);
  const wsRef = useRef(null);
  const animationFrameRef = useRef(null);
  const noiseGateRef = useRef({ threshold: 0.01, ratio: 0.1 });

  // Load reference pitch data
  useEffect(() => {
    const loadReferencePitch = async () => {
      try {
        const response = await axios.get(`${BACKEND_URL}/reference-pitch`);
        setReferencePitch(response.data);
        
        // Calculate duration from reference pitch data
        if (response.data.length > 0) {
          const lastPoint = response.data[response.data.length - 1];
          setDuration(lastPoint.timestamp);
        }
      } catch (error) {
        console.error('Error loading reference pitch:', error);
      }
    };
    
    loadReferencePitch();
  }, []);

  // WebSocket connection
  useEffect(() => {
    if (isRecording) {
      wsRef.current = new WebSocket(WS_URL);
      
      wsRef.current.onopen = () => {
        console.log('WebSocket connected');
      };
      
      wsRef.current.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.type === 'pitch_update') {
          // Update user pitch data
          const newUserPitch = data.user_pitch.map(point => ({
            ...point,
            timestamp: point.timestamp + data.time_offset
          }));
          
          setUserPitchData(prev => [...prev, ...newUserPitch]);
          
          // Check for problem sections
          const problems = data.comparisons.filter(comp => 
            comp.deviation_percentage && comp.deviation_percentage > 30
          );
          
          if (problems.length > 0) {
            setProblemSections(prev => [...prev, ...problems]);
          }
        } else if (data.type === 'performance_complete') {
          setPerformanceComplete(true);
        }
      };
      
      wsRef.current.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
      
      wsRef.current.onclose = () => {
        console.log('WebSocket disconnected');
      };
    } else {
      if (wsRef.current) {
        wsRef.current.close();
      }
    }
    
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [isRecording]);

  // Audio playback time update
  useEffect(() => {
    if (isPlaying) {
      const startTime = Date.now();
      const initialCurrentTime = currentTime;
      
      const updateTime = () => {
        const elapsed = (Date.now() - startTime) / 1000;
        const newTime = initialCurrentTime + elapsed;
        setCurrentTime(newTime);
        
        // Send current position to backend (only after song starts)
        if (newTime >= 0 && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'song_position',
            position: newTime
          }));
        }
        
        if (isPlaying) {
          animationFrameRef.current = requestAnimationFrame(updateTime);
        }
      };
      
      updateTime();
    }
    
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [isPlaying]);

  // Start recording and playing
  const startPerformance = async () => {
    try {
      // Reset data
      setUserPitchData([]);
      setProblemSections([]);
      setPerformanceComplete(false);
      
      // Reset to initial position
      setCurrentTime(0);
      
      // Start the graph animation immediately
      setIsPlaying(true);
      
      // Delay audio start by 2 seconds (when first pitch hits reference line)
      setTimeout(async () => {
        if (audioRef.current) {
          audioRef.current.currentTime = 0;
          await audioRef.current.play();
        }
      }, 2000);
      
      // Start microphone recording immediately
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          highpassFilter: true,
          channelCount: 1,
          sampleRate: 48000,
          sampleSize: 16
        } 
      });
      
      mediaStreamRef.current = stream;
      
      // Create audio context without specifying sample rate - let it use default
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      
      const source = audioContextRef.current.createMediaStreamSource(stream);
      
      // Create script processor for capturing audio chunks
      const processor = audioContextRef.current.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      
      processor.onaudioprocess = (e) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          const inputData = e.inputBuffer.getChannelData(0);
          
          // Apply advanced noise reduction
          const processedData = applyNoiseReduction(inputData);
          
          const float32Array = new Float32Array(processedData);
          
          // Convert to base64 for transmission
          const base64Audio = btoa(String.fromCharCode(...new Uint8Array(float32Array.buffer)));
          
          wsRef.current.send(JSON.stringify({
            type: 'audio_chunk',
            audio_data: base64Audio
          }));
        }
      };
      
      source.connect(processor);
      processor.connect(audioContextRef.current.destination);
      
      setIsRecording(true);
    } catch (error) {
      console.error('Error starting performance:', error);
    }
  };

  // Stop recording and playing
  const stopPerformance = () => {
    // Stop audio playback
    if (audioRef.current) {
      audioRef.current.pause();
      setIsPlaying(false);
    }
    
    // Stop microphone recording
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
    }
    
    if (processorRef.current) {
      processorRef.current.disconnect();
    }
    
    if (audioContextRef.current) {
      audioContextRef.current.close();
    }
    
    // Send end message
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'end_performance'
      }));
    }
    
    setIsRecording(false);
  };

  // Prepare data for visualization
  const prepareChartData = () => {
    // Guitar Hero style: 5-second window (2 seconds past + 3 seconds future)
    // Reference line positioned at 2 seconds into the window
    const windowStart = currentTime - 2;
    const windowEnd = currentTime + 3;
    
    // Song content is offset by 2 seconds (starts at time 2 when currentTime = 0)
    const songOffset = 2;
    
    // Filter reference pitch data with offset
    const filteredReference = referencePitch.filter(
      point => {
        const displayTime = point.timestamp + songOffset;
        return displayTime >= windowStart && displayTime <= windowEnd;
      }
    );
    
    // Filter user pitch data with offset
    const filteredUser = userPitchData.filter(
      point => {
        const displayTime = point.timestamp + songOffset;
        return displayTime >= windowStart && displayTime <= windowEnd;
      }
    );
    
    // Combine data for chart
    const chartData = [];
    const timeStep = 0.05; // 50ms intervals
    
    for (let time = windowStart; time <= windowEnd; time += timeStep) {
      // Find reference point (accounting for offset)
      const refPoint = filteredReference.find(
        p => Math.abs((p.timestamp + songOffset) - time) < timeStep / 2
      );
      
      // Find user point (accounting for offset)
      const userPoint = filteredUser.find(
        p => Math.abs((p.timestamp + songOffset) - time) < timeStep / 2
      );
      
      chartData.push({
        time: time,
        reference: refPoint ? refPoint.pitch : null,
        user: userPoint ? userPoint.pitch : null
      });
    }
    
    return chartData;
  };

  // Format time display
  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Find problem sections in current view
  const getCurrentProblemSections = () => {
    const grouped = [];
    let currentSection = null;
    
    problemSections.forEach((problem) => {
      if (currentSection === null || 
          problem.timestamp - currentSection.endTime > 0.5) {
        currentSection = {
          startTime: problem.timestamp,
          endTime: problem.timestamp,
          avgDeviation: problem.deviation_percentage
        };
        grouped.push(currentSection);
      } else {
        currentSection.endTime = problem.timestamp;
        currentSection.avgDeviation = 
          (currentSection.avgDeviation + problem.deviation_percentage) / 2;
      }
    });
    
    return grouped.filter(section => 
      section.endTime - section.startTime > 0.5
    );
  };

  // Advanced noise cancellation function
  const applyNoiseReduction = (audioData) => {
    const length = audioData.length;
    const processedData = new Float32Array(length);
    
    // Calculate RMS (Root Mean Square) for volume analysis
    let rms = 0;
    for (let i = 0; i < length; i++) {
      rms += audioData[i] * audioData[i];
    }
    rms = Math.sqrt(rms / length);
    
    // Dynamic threshold based on signal strength
    const dynamicThreshold = Math.max(0.005, rms * 0.1);
    
    // Apply noise gate with attack/release
    for (let i = 0; i < length; i++) {
      const sample = audioData[i];
      const amplitude = Math.abs(sample);
      
      if (amplitude > dynamicThreshold) {
        // Signal above threshold - apply gentle compression
        processedData[i] = sample * 0.8;
      } else {
        // Signal below threshold - apply noise gate
        processedData[i] = sample * 0.1;
      }
    }
    
    // Apply simple high-pass filtering to remove low-frequency noise
    if (length > 2) {
      for (let i = 1; i < length - 1; i++) {
        // Simple high-pass filter (removes low frequency rumble)
        processedData[i] = processedData[i] - 0.3 * (processedData[i-1] + processedData[i+1]) / 2;
      }
    }
    
    return processedData;
  };

  const chartData = prepareChartData();

  return (
    <div className="App">
      <header className="App-header">
        <h1>AI Duolingo For Singing</h1>
      </header>
      
      <main className="App-main">
        <div className="controls">
          <button 
            onClick={isRecording ? stopPerformance : startPerformance}
            className={`control-button ${isRecording ? 'stop' : 'start'}`}
          >
            {isRecording ? 'Stop Performance' : 'Start Performance'}
          </button>
          
          <div className="time-display">
            {formatTime(currentTime)} / {formatTime(duration)}
          </div>
        </div>
        
        <div className="pitch-visualizer">
          <h2>Pitch Comparison</h2>
          <ResponsiveContainer width="100%" height={400}>
            <LineChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis 
                dataKey="time" 
                domain={[currentTime - 2, currentTime + 3]}
                tickFormatter={formatTime}
              />
              <YAxis 
                domain={[100, 350]}
                label={{ value: 'Pitch (Hz)', angle: -90, position: 'insideLeft' }}
              />
              <Tooltip 
                labelFormatter={(value) => `Time: ${formatTime(value)}`}
                formatter={(value) => value ? `${value.toFixed(1)} Hz` : 'N/A'}
              />
              
              {/* Reference line - fixed at current evaluation position */}
              <ReferenceLine x={currentTime} stroke="#FF0080" strokeWidth={3} strokeDasharray="5 5" />
              
              {/* Reference pitch line */}
              <Line 
                type="monotone" 
                dataKey="reference" 
                stroke="#FFA500" 
                strokeWidth={3}
                dot={false}
                connectNulls={false}
                name="Original"
              />
              
              {/* User pitch line */}
              <Line 
                type="monotone" 
                dataKey="user" 
                stroke="#00FF00" 
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                name="Your Voice"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
        
        {performanceComplete && (
          <div className="performance-analysis">
            <h2>Performance Analysis</h2>
            {getCurrentProblemSections().length > 0 ? (
              <div className="problem-sections">
                <h3>Areas for Improvement:</h3>
                <ul>
                  {getCurrentProblemSections().map((section, index) => (
                    <li key={index}>
                      {formatTime(section.startTime)} - {formatTime(section.endTime)}: 
                      Average deviation {section.avgDeviation.toFixed(1)}%
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p>Great job! Your pitch accuracy was excellent!</p>
            )}
          </div>
        )}
        
        {/* Hidden audio element */}
        <audio 
          ref={audioRef} 
          src={`${BACKEND_URL}/song/song-music.mp3`}
          onEnded={stopPerformance}
        />
        
        {/* Avatar Agent Section */}
        <div className="avatar-section">
          {!showAvatar ? (
            <button 
              className="avatar-toggle-button"
              onClick={() => setShowAvatar(true)}
            >
              Show AI Assistant Avatar
            </button>
          ) : (
            <>
              <button 
                className="avatar-toggle-button hide"
                onClick={() => setShowAvatar(false)}
              >
                Hide Avatar
              </button>
              {liveKitToken ? (
                <AvatarAgent 
                  token={liveKitToken}
                  serverUrl={LIVEKIT_SERVER_URL}
                />
              ) : (
                <div className="avatar-token-info">
                  <p>To connect to the avatar, you need a LiveKit token.</p>
                  <p>Please configure your LiveKit credentials in the environment variables.</p>
                  <button 
                    className="generate-token-button"
                    onClick={generateDemoToken}
                  >
                    Generate Demo Token
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
  
  // Function to generate a demo token (placeholder - replace with actual token generation)
  async function generateDemoToken() {
    try {
      // Call the backend endpoint to generate a token
      const response = await axios.post(`${BACKEND_URL}/generate-livekit-token`, {
        room_name: "avatar-room",
        participant_name: "user"
      });
      
      setLiveKitToken(response.data.token);
      console.log('LiveKit token generated successfully');
    } catch (error) {
      console.error('Error generating token:', error);
      // Show error message to user
      alert('Failed to generate LiveKit token. Please ensure the backend is running and LiveKit credentials are configured.');
    }
  }
}

export default App;