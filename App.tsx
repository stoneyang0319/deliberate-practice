// Deliberate Practice – Tabs + Streak + Recording (single-file App.tsx)
// ---------------------------------------------------------------------
// Features
// - Bottom tabs: Home (Today) and Skills (curriculum map)
// - Home shows: streak calendar, Today’s drills (1–3), Bottlenecks (rating \u003c 3.0), Quick Start
// - Drill runner with audible metronome (expo-av) + visual pulse
// - Record practice audio (expo-av Recording)
// - After sets: 5-star rating + reflection → Summary; logs session and updates streak + spaced schedule
// - AsyncStorage persistence of rudiment ratings and session log
//
// Quick start
// 1) npx create-expo-app@latest deliberate-practice --template blank-typescript
// 2) cd deliberate-practice
// 3) npx expo install @react-navigation/native @react-navigation/native-stack @react-navigation/bottom-tabs react-native-screens react-native-safe-area-context react-native-gesture-handler expo-haptics expo-av @react-native-async-storage/async-storage
// 4) Add a short click sound at ./assets/click.mp3 (any short percussive sound)
// 5) Replace App.tsx with this file → npx expo start -c

import 'react-native-gesture-handler';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { View, Text, Pressable, TextInput, ScrollView, Platform, ActivityIndicator } from 'react-native';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';

// -----------------------------
// Types & Constants
// -----------------------------
type RubricCriterion = { id: string; name: string; weight: number };
type Rudiment = { id: string; name: string; tier: 1|2|3|4; sticking: string; chart: string };
type RudimentProgress = { rating: number; lastPracticedAt?: string; nextDueAt?: string };
type PlanItem = { rudimentId: string; bpm: number; sets: number; durationSec: number };

const EMA_ALPHA = 0.3;
const STORAGE_KEY = 'rudiments_progress_v1';
const SESSIONS_KEY = 'sessions_log_v1'; // ISO date strings (yyyy-mm-dd) per day practiced

// -----------------------------
// Seed data – subset of 40 Essential Rudiments (extend as needed)
// -----------------------------
function chart16(tokens: string[]) {
  const labels = ['1','e','&','a','2','e','&','a'];
  return labels.map((lab,i) => `${lab.padEnd(2,' ')}:${(tokens[i]??'-').padEnd(3,' ')}`).join('  ');
}
const RUDIMENTS: Rudiment[] = [
  { id: 'single-stroke-roll', name: 'Single Stroke Roll', tier: 1, sticking: 'R L R L R L R L', chart: chart16(['R','L','R','L','R','L','R','L']) },
  { id: 'double-stroke-roll', name: 'Double Stroke Roll', tier: 1, sticking: 'R R L L R R L L', chart: chart16(['R','R','L','L','R','R','L','L']) },
  { id: 'single-paradiddle', name: 'Single Paradiddle', tier: 1, sticking: 'R L R R L R L L', chart: chart16(['R','L','R','R','L','R','L','L']) },
  { id: 'flam', name: 'Flam', tier: 1, sticking: 'fR fL alternating', chart: chart16(['fR','-','fL','-','fR','-','fL','-']) },
  { id: 'drag', name: 'Drag', tier: 1, sticking: 'drR drL alternating', chart: chart16(['drR','-','drL','-','drR','-','drL','-']) },
  { id: 'paradiddle-diddle', name: 'Paradiddle-Diddle', tier: 2, sticking: 'R L R R L L', chart: chart16(['R','L','R','R','L','L','-','-']) },
  { id: 'five-stroke-roll', name: '5 Stroke Roll', tier: 2, sticking: 'RR LL R', chart: chart16(['R','R','L','L','R','-','-','-']) },
  { id: 'flam-tap', name: 'Flam Tap', tier: 2, sticking: 'fR R fL L', chart: chart16(['fR','R','fL','L','fR','R','fL','L']) },
];
const byId = Object.fromEntries(RUDIMENTS.map(r => [r.id, r] as const));

const RUDIMENT_RUBRIC: RubricCriterion[] = [
  { id: 'sticking', name: 'Sticking Accuracy', weight: 0.5 },
  { id: 'evenness', name: 'Evenness / Open-Close', weight: 0.3 },
  { id: 'tempo', name: 'Tempo Control', weight: 0.2 },
];

// -----------------------------
// Helpers
// -----------------------------
function startOfToday(): Date { const d = new Date(); d.setHours(0,0,0,0); return d; }
function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate()+n); return x; }
function scheduleNextDue(repScore: number): Date { if (repScore <= 2) return addDays(startOfToday(),1); if (repScore===3) return addDays(startOfToday(),2); return addDays(startOfToday(),4); }
function weightedAvg(scores: Record<string, number>, rubric: RubricCriterion[]) { let sum=0,w=0; rubric.forEach(c=>{sum+=(scores[c.id]??0)*c.weight; w+=c.weight;}); return Number((sum/(w||1)).toFixed(2)); }
async function loadProgress(): Promise<Record<string, RudimentProgress>> { try{const raw=await AsyncStorage.getItem(STORAGE_KEY); return raw?JSON.parse(raw):{};}catch{return{}} }
async function saveProgress(p: Record<string, RudimentProgress>) { await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(p)); }
async function loadSessions(): Promise<string[]> { try{const raw=await AsyncStorage.getItem(SESSIONS_KEY); return raw?JSON.parse(raw):[];}catch{return[]} }
async function saveSessions(s: string[]) { await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(s)); }
function ymd(d: Date) { return d.toISOString().slice(0,10); }

function computeTodayPlan(progress: Record<string, RudimentProgress>, fallbackBPM=80): PlanItem[] {
  const today = startOfToday();
  const due = RUDIMENTS
    .map(r => ({ r, pr: progress[r.id] }))
    .sort((a,b) => {
      const ad = a.pr?.nextDueAt ? new Date(a.pr.nextDueAt).getTime() : -Infinity;
      const bd = b.pr?.nextDueAt ? new Date(b.pr.nextDueAt).getTime() : -Infinity;
      return ad - bd || (a.pr?.rating ?? 2.5) - (b.pr?.rating ?? 2.5) || a.r.tier - b.r.tier;
    })
    .filter(x => !x.pr?.nextDueAt || new Date(x.pr.nextDueAt) <= today)
    .slice(0,3)
    .map(x => ({ rudimentId: x.r.id, bpm: fallbackBPM, sets: 3, durationSec: 60 }));

  if (due.length < 3) {
    const chosen = new Set(due.map(d => d.rudimentId));
    for (const r of RUDIMENTS) {
      if (chosen.size >= 3) break;
      if (!chosen.has(r.id)) { chosen.add(r.id); due.push({ rudimentId: r.id, bpm: fallbackBPM, sets: 3, durationSec: 60 }); }
    }
  }
  return due.slice(0,3);
}

function computeStreak(sessions: string[]): { current: number; last14: { date: string; hit: boolean }[] } {
  const set = new Set(sessions);
  const today = startOfToday();
  // last 14 days mini-calendar
  const last14 = Array.from({length:14}, (_,i)=>{ const d=addDays(today,-(13-i)); return { date: ymd(d), hit: set.has(ymd(d)) }; });
  // current streak count
  let cur=0; for(let i=0;;i++){ const d=addDays(today,-i); if(set.has(ymd(d))) cur++; else break; }
  return { current: cur, last14 };
}

// -----------------------------
// Navigation
// -----------------------------
const Stack = createNativeStackNavigator();
const Tabs = createBottomTabNavigator();

type RootNav = {
  Tabs: undefined;
  RudimentDetail: { item: PlanItem };
  ScoreReflect: { item: PlanItem };
  Summary: { item: PlanItem; repScore: number };
};

// -----------------------------
// UI Helpers
// -----------------------------
function Button({ title, onPress, variant='primary' }: { title: string; onPress: () => void; variant?: 'primary'|'ghost' }) {
  return (
    <Pressable onPress={onPress} style={{ borderRadius: 16, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: variant==='primary' ? '#111827' : '#ffffff', borderWidth: variant==='ghost'?1:0, borderColor: '#e5e7eb', alignItems: 'center', marginTop: 8 }}>
      <Text style={{ color: variant==='primary' ? '#fff' : '#111827', fontWeight: '600' }}>{title}</Text>
    </Pressable>
  );
}

function StarRating({ value, onChange }: { value: number; onChange: (n:number)=>void }) {
  return (
    <View style={{ flexDirection:'row', gap:6 }}>
      {[1,2,3,4,5].map(i => (
        <Pressable key={i} onPress={()=>onChange(i)}>
          <Text style={{ fontSize: 28 }}>{i <= value ? '★' : '☆'}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function StreakCalendar({ last14, current }: { last14: {date:string; hit:boolean}[]; current: number }) {
  return (
    <View style={{ borderWidth:1, borderColor:'#e5e7eb', borderRadius:12, padding:12 }}>
      <Text style={{ fontWeight:'700', marginBottom:6 }}>Streak: {current} day{current===1?'':'s'}</Text>
      <View style={{ flexDirection:'row', flexWrap:'wrap', gap:6 }}>
        {last14.map((d,i)=> (
          <View key={d.date} style={{ width:18, height:18, borderRadius:9, backgroundColor: d.hit ? '#10b981' : '#e5e7eb' }} />
        ))}
      </View>
      <Text style={{ marginTop:6, opacity:0.6 }}>Last 14 days</Text>
    </View>
  );
}

// -----------------------------
// Tabs: Home (Today) and Skills
// -----------------------------
function HomeTab({ navigation }: any) {
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<Record<string, RudimentProgress>>({});
  const [sessions, setSessions] = useState<string[]>([]);
  const [bpm, setBpm] = useState(80);

  useEffect(() => { (async () => { const p = await loadProgress(); const s = await loadSessions(); setProgress(p); setSessions(s); setLoading(false); })(); }, []);

  const plan = useMemo(() => computeTodayPlan(progress, bpm), [progress, bpm]);
  const bottlenecks = useMemo(() => Object.entries(progress).filter(([id, pr]) => (pr.rating ?? 2.5) < 3).slice(0,3).map(([id]) => byId[id]?.name).filter(Boolean), [progress]);
  const streak = useMemo(() => computeStreak(sessions), [sessions]);

  if (loading) return <View style={{ flex:1, alignItems:'center', justifyContent:'center' }}><ActivityIndicator /></View>;

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <StreakCalendar last14={streak.last14} current={streak.current} />

      {/* Today’s drills */}
      <View style={{ borderWidth:1, borderColor:'#e5e7eb', borderRadius:12, padding:12, marginTop:12 }}>
        <Text style={{ fontWeight:'700', marginBottom:6 }}>Today’s drills (1–3)</Text>
        {plan.map((p, i) => (
          <View key={i} style={{ paddingVertical:8 }}>
            <Text style={{ fontWeight:'600' }}>{byId[p.rudimentId].name}</Text>
            <Text style={{ opacity:0.7 }}>Params: {p.sets}×{p.durationSec}s @ {p.bpm} bpm</Text>
            <Button title="Open" onPress={() => navigation.navigate('RudimentDetail', { item: p })} />
          </View>
        ))}
      </View>

      {/* Bottlenecks */}
      <View style={{ borderWidth:1, borderColor:'#e5e7eb', borderRadius:12, padding:12, marginTop:12 }}>
        <Text style={{ fontWeight:'700', marginBottom:6 }}>Bottlenecks (rating {'<'} 3.0)</Text>
        {bottlenecks.length ? bottlenecks.map((n, i) => <Text key={i}>• {n}</Text>) : <Text style={{ opacity:0.7 }}>None yet — keep practicing!</Text>}
      </View>

      {/* Quick start */}
      <Button title="Start Session" onPress={() => navigation.navigate('RudimentDetail', { item: plan[0] })} />

      {/* BPM control for the day */}
      <View style={{ borderWidth:1, borderColor:'#e5e7eb', borderRadius:12, padding:12, marginTop:12 }}>
        <Text style={{ fontWeight:'700', marginBottom:6 }}>Default BPM for today</Text>
        <TextInput keyboardType="number-pad" value={String(bpm)} onChangeText={(t)=>setBpm(Number(t.replace(/[^0-9]/g,'')||0))} style={{ borderWidth:1, borderColor:'#e5e7eb', borderRadius:12, padding:10 }} />
      </View>
    </ScrollView>
  );
}

function SkillsTab() {
  // Simple curriculum tree (by tier)
  const tiers = [1,2,3,4] as const;
  return (
    <ScrollView contentContainerStyle={{ padding:16 }}>
      <Text style={{ fontSize:22, fontWeight:'800', marginBottom:8 }}>Curriculum</Text>
      {tiers.map(t => (
        <View key={t} style={{ borderWidth:1, borderColor:'#e5e7eb', borderRadius:12, padding:12, marginBottom:10 }}>
          <Text style={{ fontWeight:'700', marginBottom:6 }}>Tier {t}</Text>
          {RUDIMENTS.filter(r=>r.tier===t).map(r => (
            <Text key={r.id}>• {r.name}</Text>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

function TabsShell() {
  return (
    <Tabs.Navigator screenOptions={{ headerShown:false }}>
      <Tabs.Screen name="HomeTab" component={HomeTab} options={{ title:'Home' }} />
      <Tabs.Screen name="SkillsTab" component={SkillsTab} options={{ title:'Skills' }} />
    </Tabs.Navigator>
  );
}

// -----------------------------
// Flow screens: Detail -> ScoreReflect -> Summary
// -----------------------------
function RudimentDetailScreen({ route, navigation }: any) {
  const { item } = route.params as { item: PlanItem };
  const r = byId[item.rudimentId];

  const [bpm, setBpm] = useState(item.bpm);
  const [sets, setSets] = useState(item.sets);
  const [durationSec, setDurationSec] = useState(item.durationSec);

  const [running, setRunning] = useState(false);
  const [beat, setBeat] = useState(1);
  const [secLeft, setSecLeft] = useState(durationSec);
  const [setIndex, setSetIndex] = useState(1);

  // Audio click
  const soundRef = useRef<Audio.Sound | null>(null);
  const [soundReady, setSoundReady] = useState(false);

  // Recording
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [recordingUri, setRecordingUri] = useState<string | null>(null);

  useEffect(() => { setSecLeft(durationSec); }, [durationSec]);

  useEffect(() => {
    (async () => {
      try {
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true, allowsRecordingIOS: true });
        const { sound } = await Audio.Sound.createAsync(require('./assets/click.mp3'));
        soundRef.current = sound; setSoundReady(true);
      } catch (e) { setSoundReady(false); }
    })();
    return () => { soundRef.current?.unloadAsync(); };
  }, []);

  useEffect(() => {
    if (!running) return;
    const secTimer = setInterval(() => setSecLeft((s) => Math.max(0, s - 1)), 1000);
    const interval = Math.max(100, Math.round(60_000 / bpm));
    const beatTimer = setInterval(async () => {
      setBeat((b) => (b % 4) + 1);
      if (soundReady && soundRef.current) { try { await soundRef.current.replayAsync(); } catch {} }
      else { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }
    }, interval);
    return () => { clearInterval(secTimer); clearInterval(beatTimer); };
  }, [running, bpm, soundReady]);

  useEffect(() => { if (secLeft === 0 && running) setRunning(false); }, [secLeft, running]);

  async function toggleRecord() {
    if (recording) {
      try { await recording.stopAndUnloadAsync(); const uri = recording.getURI(); setRecordingUri(uri || null); } catch {}
      setRecording(null);
      return;
    }
    const permission = await Audio.requestPermissionsAsync();
    if (!permission.granted) return;
    const rec = new Audio.Recording();
    try {
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await rec.startAsync();
      setRecording(rec);
    } catch (e) { /* noop */ }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <Text style={{ fontSize: 22, fontWeight: '800' }}>{r.name}</Text>
      <Text style={{ marginTop: 4, opacity: 0.7 }}>Sticking: {r.sticking}</Text>

      <View style={{ borderWidth:1, borderColor:'#e5e7eb', borderRadius:12, padding:12, marginTop:12 }}>
        <Text style={{ fontWeight:'700', marginBottom:6 }}>Drum Chart (ASCII 16ths)</Text>
        <Text style={{ fontFamily: Platform.select({ ios:'Menlo', android:'monospace' }), lineHeight: 20 }}>{r.chart}</Text>
      </View>

      {/* Params */}
      <View style={{ borderWidth:1, borderColor:'#e5e7eb', borderRadius:12, padding:12, marginTop:12 }}>
        <Text style={{ fontWeight:'700', marginBottom:6 }}>Params</Text>
        <Text>Sets: {sets} • Duration/set: {durationSec}s • BPM: {bpm}</Text>
        <View style={{ flexDirection:'row', gap:10, marginTop:8 }}>
          <Button title="- BPM" variant="ghost" onPress={() => setBpm(Math.max(40, bpm-5))} />
          <Button title="+ BPM" variant="ghost" onPress={() => setBpm(Math.min(240, bpm+5))} />
        </View>
      </View>

      {/* Metronome visual */}
      <View style={{ flexDirection:'row', gap:8, marginTop:12 }}>
        {[1,2,3,4].map(i => (
          <View key={i} style={{ width:18, height:18, borderRadius:9, backgroundColor: beat===i && running ? '#10b981' : '#e5e7eb' }} />
        ))}
      </View>
      <Text style={{ marginBottom:8 }}>Time left: {secLeft}s • Set {setIndex}/{sets}</Text>

      <Button title={running ? 'Pause' : 'Start'} onPress={() => setRunning(r => !r)} />
      <Button title={recording ? 'Stop Recording' : 'Record Practice'} variant="ghost" onPress={toggleRecord} />
      {recordingUri ? <Text style={{ marginTop:6, opacity:0.7 }}>Saved recording: {recordingUri.slice(0,28)}…</Text> : null}

      {!running && secLeft === 0 && (
        <Button title={setIndex < sets ? 'Next Set' : 'Score & Reflect'} onPress={() => {
          if (setIndex < sets) { setSetIndex(setIndex+1); setSecLeft(durationSec); }
          else { navigation.navigate('ScoreReflect', { item: { ...item, bpm, sets, durationSec } }); }
        }} />
      )}
      {!running && secLeft !== 0 && <Button title="Reset Time" variant="ghost" onPress={() => setSecLeft(durationSec)} />}
    </ScrollView>
  );
}

function ScoreReflectScreen({ route, navigation }: any) {
  const { item } = route.params as { item: PlanItem };
  const r = byId[item.rudimentId];
  const [scores, setScores] = useState<Record<string, number>>(Object.fromEntries(RUDIMENT_RUBRIC.map(c => [c.id, 3])));
  const [notes, setNotes] = useState('');
  const [stars, setStars] = useState(3);

  const repScore = useMemo(() => weightedAvg(scores, RUDIMENT_RUBRIC), [scores]);

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <Text style={{ fontSize: 22, fontWeight: '800', marginBottom: 12 }}>Score & Reflect</Text>

      <Text style={{ fontWeight:'700', marginBottom:6 }}>Overall (5-star)</Text>
      <StarRating value={stars} onChange={setStars} />

      {RUDIMENT_RUBRIC.map((c) => (
        <View key={c.id} style={{ borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 12, padding: 12, marginTop: 10 }}>
          <Text style={{ fontWeight: '600', marginBottom: 6 }}>{c.name} (w {c.weight})</Text>
          <View style={{ flexDirection:'row', gap:6 }}>
            {[1,2,3,4,5].map(i => (
              <Pressable key={i} onPress={()=>setScores(s=>({ ...s, [c.id]: i }))}>
                <Text style={{ fontSize: 24 }}>{(scores[c.id]??3) >= i ? '●' : '○'}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ))}

      <View style={{ borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 12, padding: 12, marginTop: 10 }}>
        <Text style={{ fontWeight: '600', marginBottom: 6 }}>Reflection</Text>
        <TextInput placeholder="What to change next time?" value={notes} onChangeText={setNotes} multiline style={{ borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 12, padding: 10, minHeight: 80 }} />
      </View>

      <Button title="Save & Summary" onPress={() => navigation.navigate('Summary', { item, repScore })} />
      <Text style={{ marginTop: 12, opacity: 0.6 }}>RepScore (weighted): {repScore}</Text>
      <Text style={{ marginTop: 4, opacity: 0.6 }}>Rudiment: {r.name}</Text>
    </ScrollView>
  );
}

function SummaryScreen({ route, navigation }: any) {
  const { item, repScore } = route.params as { item: PlanItem; repScore: number };
  const r = byId[item.rudimentId];
  const [saving, setSaving] = useState(false);
  const suggestionText = useMemo(() => {
    if (repScore <= 2) return `Next: 3×60s @ ${Math.max(40, Math.round(item.bpm*0.85))} bpm. Focus on lowest-scoring criterion.`;
    if (repScore === 3) return `Repeat: 3×60s @ ${item.bpm} bpm. Refine consistency.`;
    return `Progress: 3×60s @ ${Math.round(item.bpm*1.07)} bpm. Add accent on every 4th note.`;
  }, [repScore, item.bpm]);

  async function persistResult() {
    setSaving(true);
    const progress = await loadProgress();
    const prev = progress[item.rudimentId] ?? { rating: 2.5 } as RudimentProgress;
    const newRating = Number((EMA_ALPHA * repScore + (1-EMA_ALPHA) * (prev.rating ?? 2.5)).toFixed(2));
    const nextDue = scheduleNextDue(repScore);
    progress[item.rudimentId] = { rating: newRating, lastPracticedAt: new Date().toISOString(), nextDueAt: nextDue.toISOString() };
    await saveProgress(progress);

    const sessions = await loadSessions();
    const today = ymd(startOfToday());
    if (!sessions.includes(today)) { sessions.push(today); await saveSessions(sessions); }
    setSaving(false);
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <Text style={{ fontSize: 22, fontWeight: '800', marginBottom: 12 }}>Session Summary</Text>
      <View style={{ borderWidth:1, borderColor:'#e5e7eb', borderRadius:12, padding:12 }}>
        <Text style={{ fontWeight:'700' }}>{r.name}</Text>
        <Text style={{ marginTop:6 }}>Params: {item.sets}×{item.durationSec}s @ {item.bpm} bpm</Text>
        <Text style={{ marginTop:6, fontWeight:'600' }}>RepScore: {repScore}</Text>
      </View>

      <View style={{ borderWidth:1, borderColor:'#e5e7eb', borderRadius:12, padding:12, marginTop:12 }}>
        <Text style={{ fontWeight:'700', marginBottom:6 }}>Next Drill Suggestion</Text>
        <Text>{suggestionText}</Text>
      </View>

      <Button title={saving ? 'Saving…' : 'Save & Back to Today'} onPress={async () => { await persistResult(); navigation.popToTop(); }} />
    </ScrollView>
  );
}

// -----------------------------
// App root
// -----------------------------
export default function App() {
  return (
    <NavigationContainer>
      <Stack.Navigator>
        <Stack.Screen name="Tabs" component={TabsShell} options={{ headerShown:false }} />
        <Stack.Screen name="RudimentDetail" component={RudimentDetailScreen} options={{ title: 'Detail & Metronome' }} />
        <Stack.Screen name="ScoreReflect" component={ScoreReflectScreen} options={{ title: 'Score & Reflect' }} />
        <Stack.Screen name="Summary" component={SummaryScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
