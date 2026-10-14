export interface Participant {
  id: string;
  name: string;
}

export interface DrawRecord {
  id: string;
  participantId: string;
  name: string;
  drawnAt: number;
}

export interface ParticipantItem {
  id: string;
  label: string;
}
