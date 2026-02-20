import { Server } from 'socket.io';
import http from 'http';
import { AIPeerService, createAIPeerService } from '../webrtc/aipeerservice';

export const setupSocket = (server: http.Server) => {
    const io = new Server(server, {
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
        },
    });

    const aiPeers = new Map<string, AIPeerService>();

    // Map to track active calls: receiverId -> senderId
    const activeCalls = new Map<string, { from: string, name: string, offer: any, status: 'ringing' | 'connected' }>();
    // Map to track which user is in which call (userId -> callId/receiverId)
    const userCallState = new Map<string, string>();

    io.on('connection', (socket) => {
        let currentUserId: string | null = null;
        console.log('New client connected:', socket.id);

        socket.on('join', (userId) => {
            currentUserId = userId;
            socket.join(userId);
            console.log(`[SIGNAL] User ${userId} joined room ${userId}`);
        });

        socket.on('call-user', async ({ to, offer, from, name, callerName, callerLanguage, receiverLanguage }) => {
            console.log(`[SIGNAL] call-user from ${from} to ${to}`);

            if (to === '10') {
                console.log(`[SIGNAL] AI Call detected from ${from}`);
                try {
                    const aiPeer = createAIPeerService(from);
                    aiPeers.set(from, aiPeer);

                    const finalCallerName = callerName || 'User';
                    aiPeer.initializeCall(finalCallerName);
                    console.log(`[SIGNAL] AI Call initiated for caller: ${finalCallerName}`);

                    // Handle ICE candidates from AI peer - setup BEFORE answering
                    aiPeer.pc.onicecandidate = (event) => {
                        if (event.candidate) {
                            console.log(`[ICE] AI Peer generated candidate: ${event.candidate.candidate?.split(' ')[7] || 'relay'}`);
                            socket.emit('ice-candidate', {
                                candidate: event.candidate,
                                from: '10'
                            });
                        }
                    };

                    aiPeer.pc.onconnectionstatechange = () => {
                        console.log(`[AI_PEER] PC Connection State: ${aiPeer.pc.connectionState}`);
                    };

                    aiPeer.pc.oniceconnectionstatechange = () => {
                        console.log(`[AI_PEER] ICE Connection State: ${aiPeer.pc.iceConnectionState}`);
                    };

                    const answer = await aiPeer.createAnswer(offer);
                    socket.emit('call-answered', { answer });
                    userCallState.set(from, '10');
                    console.log(`[SIGNAL] AI Call answered for ${from}`);
                } catch (error: any) {
                    console.error("[SIGNAL] AI Peer setup failed!");
                    console.error("[SIGNAL] Error Message:", error.message);
                    console.error("[SIGNAL] Error Stack:", error.stack);
                    socket.emit('call-rejected', { reason: `AI Service Unavailable: ${error.message}` });
                }
                return;
            }

            // Standard P2P logic follows...
            const existingCall = activeCalls.get(to);
            if (existingCall && existingCall.from === from) {
                socket.emit('call-rejected', { reason: 'Call already in progress' });
                return;
            }

            activeCalls.set(to, { from, name, offer, status: 'ringing' });
            userCallState.set(from, to);
            userCallState.set(to, from);
            io.to(to).emit('incoming-call', { from, offer, name });
        });


        socket.on('answer-call', ({ to, answer }) => {
            const call = activeCalls.get(currentUserId || '');
            if (call) call.status = 'connected';
            io.to(to).emit('call-answered', { answer });
        });

        socket.on('ice-candidate', async ({ to, candidate, from }) => {
            if (to === '10') {
                const senderId = from || currentUserId;
                const aiPeer = aiPeers.get(senderId || '');
                if (aiPeer) {
                    console.log(`[ICE] Adding candidate to AI Peer from ${senderId}:`, candidate.candidate?.split(' ')[7] || 'relay');
                    try {
                        await aiPeer.pc.addIceCandidate(candidate);
                    } catch (e: any) {
                        console.error(`[ICE] Failed to add candidate: ${e.message}`);
                    }
                }
                return;
            }
            io.to(to).emit('ice-candidate', { candidate, from: from || currentUserId });
        });

        const handleCleanup = (targetId: string | null) => {
            if (!targetId) return;

            const otherId = userCallState.get(targetId);
            if (otherId === '10') {
                const aiPeer = aiPeers.get(targetId);
                if (aiPeer) {
                    aiPeer.stop();
                    aiPeers.delete(targetId);
                }
                userCallState.delete(targetId);
                return;
            }

            if (otherId) {
                activeCalls.delete(targetId);
                activeCalls.delete(otherId);
                userCallState.delete(targetId);
                userCallState.delete(otherId);
                io.to(otherId).emit('call-ended');
            }
        };

        socket.on('hangup', ({ to }) => {
            handleCleanup(currentUserId);
            if (to !== '10') io.to(to).emit('call-ended');
        });

        socket.on('disconnect', () => {
            if (currentUserId) handleCleanup(currentUserId);
        });
    });

    return io;
};
