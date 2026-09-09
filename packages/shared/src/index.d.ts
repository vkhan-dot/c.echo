export type UserRole = 'admin' | 'moderator' | 'employee';
export interface User {
    id: string;
    email: string;
    name: string;
    role: UserRole;
    avatarUrl?: string;
    createdAt: string;
}
export interface AuthTokens {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
}
export type SentiStatus = 'none' | 'processing' | 'done' | 'failed';
export interface Meeting {
    id: string;
    title: string;
    creatorId: string;
    livekitRoom: string;
    createdAt: string;
    endedAt?: string;
    durationSec?: number;
    isRecorded: boolean;
    sentiStatus: SentiStatus;
    summary?: SentiSummary;
    participants?: MeetingParticipant[];
    scheduledStart?: string | null;
    isPublic?: boolean;
    waitingRoomEnabled?: boolean;
}
export interface MeetingParticipant {
    userId: string;
    name: string;
    avatarUrl?: string;
    joinedAt: string;
}
export interface ConsentStatus {
    meetingId: string;
    total: number;
    consented: number;
    pending: User[];
    refused: User[];
    allConsented: boolean;
}
export interface TranscriptEntry {
    id: string;
    meetingId: string;
    speakerName: string;
    phrase: string;
    startSec: number;
    endSec?: number;
}
export interface SentiDecision {
    id: number;
    text: string;
    initiator: string;
    status: 'approved' | 'rejected' | 'pending';
}
export interface SentiTask {
    id: number;
    text: string;
    assignee: string;
    deadline: string | null;
}
export interface SentiKeyMoment {
    sec: number;
    label: string;
}
export interface SentiSummary {
    summary: string;
    decisions: SentiDecision[];
    tasks: SentiTask[];
    keyMoments: SentiKeyMoment[];
}
export interface SentiDiarizationEntry {
    speaker: string;
    startSec: number;
    endSec: number;
    text: string;
}
export interface SentiOutput {
    diarization: SentiDiarizationEntry[];
    summary: string;
    decisions: SentiDecision[];
    tasks: SentiTask[];
    keyMoments: SentiKeyMoment[];
}
export interface SentiChatResponse {
    answer: string;
    references: Array<{
        speaker: string;
        sec: number;
        quote: string;
    }>;
}
export interface ApiResponse<T> {
    data: T;
    error?: never;
}
export interface ApiError {
    data?: never;
    error: {
        code: string;
        message: string;
    };
}
export type ApiResult<T> = ApiResponse<T> | ApiError;
export interface LiveKitTokenResponse {
    token: string;
    serverUrl: string;
}
//# sourceMappingURL=index.d.ts.map