// ============================================================
// Dashboard Client — heartbeat + command control for NERV dashboard
// Uses the same Supabase project (FVG/OnChain) — no second client needed.
// ============================================================

import { createClient, SupabaseClient } from '@supabase/supabase-js';

let serviceClient: SupabaseClient | null = null;

function getDashboardClient(): SupabaseClient | null {
  if (serviceClient) return serviceClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  serviceClient = createClient(url, key, { auth: { persistSession: false } });
  return serviceClient;
}

let paused = false;

export function isPaused(): boolean {
  return paused;
}

export async function sendHeartbeat(activePositions: number): Promise<void> {
  const client = getDashboardClient();
  if (!client) return;

  try {
    await client.from('bot_heartbeats').insert({
      bot_name: 'onchain',
      status: paused ? 'PAUSED' : 'OK',
      active_positions: activePositions,
    });
  } catch {
    // Non-fatal
  }
}

export async function checkDashboardCommands(onKill: () => void): Promise<void> {
  const client = getDashboardClient();
  if (!client) return;

  try {
    const { data } = await client
      .from('bot_commands')
      .select('*')
      .or('bot_name.eq.onchain,bot_name.eq.all')
      .eq('status', 'PENDING')
      .order('created_at', { ascending: true });

    for (const cmd of data ?? []) {
      if (cmd.command === 'PAUSE') {
        paused = true;
      } else if (cmd.command === 'RESUME') {
        paused = false;
      } else if (cmd.command === 'KILL') {
        await client.from('bot_commands').update({
          status: 'EXECUTED',
          executed_at: new Date().toISOString(),
          result: 'KILL executed — process exiting',
        }).eq('id', cmd.id);
        onKill();
        return;
      }

      await client.from('bot_commands').update({
        status: 'EXECUTED',
        executed_at: new Date().toISOString(),
        result: `${cmd.command} executed successfully`,
      }).eq('id', cmd.id);
    }
  } catch {
    // Non-fatal
  }
}
