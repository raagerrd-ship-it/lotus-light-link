export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      calibration_songs: {
        Row: {
          artist: string
          category: string
          created_at: string
          id: string
          spotify_uri: string | null
          title: string
          votes_down: number
          votes_up: number
          why: string
        }
        Insert: {
          artist: string
          category?: string
          created_at?: string
          id?: string
          spotify_uri?: string | null
          title: string
          votes_down?: number
          votes_up?: number
          why: string
        }
        Update: {
          artist?: string
          category?: string
          created_at?: string
          id?: string
          spotify_uri?: string | null
          title?: string
          votes_down?: number
          votes_up?: number
          why?: string
        }
        Relationships: []
      }
      device_calibration: {
        Row: {
          ble_min_interval_ms: number | null
          ble_speed_results: Json | null
          calibration: Json
          device_name: string
          id: string
          latency_results: Json | null
          updated_at: string
        }
        Insert: {
          ble_min_interval_ms?: number | null
          ble_speed_results?: Json | null
          calibration?: Json
          device_name: string
          id?: string
          latency_results?: Json | null
          updated_at?: string
        }
        Update: {
          ble_min_interval_ms?: number | null
          ble_speed_results?: Json | null
          calibration?: Json
          device_name?: string
          id?: string
          latency_results?: Json | null
          updated_at?: string
        }
        Relationships: []
      }
      song_analysis: {
        Row: {
          agc_state: Json | null
          artist_name: string
          beat_grid: Json | null
          beat_strengths: Json | null
          bpm: number | null
          brightness_curve: Json | null
          calibration_snapshot: Json | null
          created_at: string | null
          danceability: number | null
          drops: Json | null
          dynamic_range: Json | null
          energy: number | null
          energy_curve: Json | null
          happiness: number | null
          id: string
          key: string | null
          loudness: string | null
          recorded_volume: number | null
          sections: Json | null
          track_name: string
          transitions: Json | null
        }
        Insert: {
          agc_state?: Json | null
          artist_name: string
          beat_grid?: Json | null
          beat_strengths?: Json | null
          bpm?: number | null
          brightness_curve?: Json | null
          calibration_snapshot?: Json | null
          created_at?: string | null
          danceability?: number | null
          drops?: Json | null
          dynamic_range?: Json | null
          energy?: number | null
          energy_curve?: Json | null
          happiness?: number | null
          id?: string
          key?: string | null
          loudness?: string | null
          recorded_volume?: number | null
          sections?: Json | null
          track_name: string
          transitions?: Json | null
        }
        Update: {
          agc_state?: Json | null
          artist_name?: string
          beat_grid?: Json | null
          beat_strengths?: Json | null
          bpm?: number | null
          brightness_curve?: Json | null
          calibration_snapshot?: Json | null
          created_at?: string | null
          danceability?: number | null
          drops?: Json | null
          dynamic_range?: Json | null
          energy?: number | null
          energy_curve?: Json | null
          happiness?: number | null
          id?: string
          key?: string | null
          loudness?: string | null
          recorded_volume?: number | null
          sections?: Json | null
          track_name?: string
          transitions?: Json | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
