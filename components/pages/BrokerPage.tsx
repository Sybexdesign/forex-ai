'use client'
// components/pages/BrokerPage.tsx — Per-user broker management (stored in Supabase)

import { useState, useEffect, useCallback } from 'react'
import { Panel, LoadingDots } from '../ui'
import { BROKER_INFO, type BrokerKey } from '@/lib/brokers/index'
import { authFetch } from '@/lib/api'

interface BrokerConfig {
  id: string
  broker_type: BrokerKey
  label: string
  config: Record<string, string>
  is_active: boolean
}

export default function BrokerPage({ onToast, onBrokerSaved }: { onToast?: (msg: string, color?: string) => void; onBrokerSaved?: () => void }) {
  const [configs, setConfigs] = useState<BrokerConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Partial<BrokerConfig> | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [showSecrets, setShowSecrets] = useState(false)
  const [changingBroker, setChangingBroker] = useState(false)

  const load = useCallback(() => {
    authFetch('/api/broker-config').then(r => r.json()).then(d => {
      setConfigs(d.configs || [])
    }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  function startNew(brokerType: BrokerKey) {
    const info = BROKER_INFO[brokerType]
    const config: Record<string, string> = {}
    info.fields.forEach(f => { config[f.key] = '' })
    if (brokerType === 'mt5direct' || brokerType === 'exness') {
      config.webhookToken = crypto.randomUUID().replace(/-/g, '')
    }
    setEditing({ broker_type: brokerType, label: info.name, config, is_active: false })
    setTestResult(null)
    setChangingBroker(false)
  }

  function startEdit(cfg: BrokerConfig) {
    setEditing({ ...cfg, config: { ...cfg.config } })
    setTestResult(null)
    setShowSecrets(false)
  }

  async function save() {
    if (!editing) return
    setSaving(true)
    try {
      const res = await authFetch('/api/broker-config', {
        method: 'POST',
        body: JSON.stringify(editing),
      })
      const d = await res.json()
      if (d.error) { onToast?.('Save failed: ' + d.error, '#ff3056'); return }
      onToast?.('Broker saved', '#00ff87')
      setEditing(null)
      load()
      onBrokerSaved?.()
    } catch (e: any) {
      onToast?.('Error: ' + e.message, '#ff3056')
    } finally { setSaving(false) }
  }

  async function deleteConfig(id: string) {
    if (!confirm('Delete this broker config?')) return
    await authFetch('/api/broker-config', { method: 'DELETE', body: JSON.stringify({ id }) })
    onToast?.('Broker removed', '#ffb800')
    load()
  }

  async function setActive(id: string) {
    await authFetch('/api/broker-config', {
      method: 'POST',
      body: JSON.stringify({ id, is_active: true }),
    })
    onToast?.('Active broker updated', '#00ff87')
    load()
    onBrokerSaved?.()
  }

  async function testConnection() {
    setTesting(true); setTestResult(null)
    try {
      const res = await authFetch('/api/account')
      const d = await res.json()
      const isMt5 = activeConfig?.broker_type === 'mt5direct' || activeConfig?.broker_type === 'exness'
      if (d.error) {
        setTestResult(`✕ Error: ${d.error}`)
      } else if (d.balance > 0) {
        const login = (activeConfig?.config as any)?.login
        const server = (activeConfig?.config as any)?.server
        const extra = login ? ` · Login ${login}${server ? ' @ ' + server : ''}` : ''
        setTestResult(`✓ Connected — ${d.currency || 'USD'} ${d.balance?.toFixed(2)}${extra} via ${d.broker}`)
      } else if (isMt5) {
        const lastSync = (activeConfig?.config as any)?.updatedAt
        if (!lastSync) {
          setTestResult(`⚠ EA has not synced yet — step-by-step checklist:\n1. EA is attached to a chart in MT5\n2. MT5: Tools → Options → Expert Advisors → Allow WebRequest → add the webhook URL\n3. Auto Trading is enabled in the MT5 toolbar`)
        } else {
          const minsAgo = Math.floor((Date.now() - new Date(lastSync).getTime()) / 60000)
          if (minsAgo < 5) {
            setTestResult(`⚠ EA is online (synced ${minsAgo}m ago) but MT5 account shows $0 — account may not be funded or is a demo that hasn't been initialized`)
          } else {
            setTestResult(`⚠ EA last synced ${minsAgo}m ago and appears offline — recheck that MT5 is open and the EA is attached to a chart`)
          }
        }
      } else {
        setTestResult(`⚠ Connected to ${d.broker} but balance is $0 — check your broker API credentials`)
      }
    } catch (e: any) {
      setTestResult('✕ Connection failed: ' + e.message)
    } finally { setTesting(false) }
  }

  const activeConfig = configs.find(c => c.is_active)
  const addBrokerKeys = Object.keys(BROKER_INFO) as BrokerKey[]
  const hasSavedConfig = configs.length > 0

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><LoadingDots /></div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 960 }}>

      {/* Active broker summary */}
      <Panel title="ACTIVE BROKER" bright>
        <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          {activeConfig ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#00ff87', boxShadow: '0 0 8px rgba(0,255,135,0.6)' }} />
                <span style={{ fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 18, color: '#90b0d0' }}>
                  {activeConfig.label}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--border)', padding: '2px 8px', borderRadius: 2 }}>
                  {activeConfig.broker_type.toUpperCase()}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
                <button onClick={testConnection} disabled={testing} className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 14px' }}>
                  {testing ? <LoadingDots /> : '⚡ Test Connection'}
                </button>
                <button onClick={() => startEdit(activeConfig)} className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 14px' }}>
                  Edit
                </button>
              </div>
              {testResult && (() => {
                const isOk   = testResult.startsWith('✓')
                const isWarn = testResult.startsWith('⚠')
                return (
                  <div style={{
                    width: '100%', padding: '10px 14px', borderRadius: 3, fontSize: 12,
                    background: isOk ? 'rgba(0,255,135,0.06)' : isWarn ? 'rgba(255,184,0,0.07)' : 'rgba(255,48,86,0.06)',
                    border: `1px solid ${isOk ? 'rgba(0,255,135,0.2)' : isWarn ? 'rgba(255,184,0,0.25)' : 'rgba(255,48,86,0.2)'}`,
                    color: isOk ? '#00ff87' : isWarn ? '#ffb800' : '#ff6060',
                    fontFamily: 'JetBrains Mono', whiteSpace: 'pre-line', lineHeight: 1.7,
                  }}>
                    {testResult}
                  </div>
                )
              })()}
            </>
          ) : (
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>No active broker — add one below</span>
          )}
        </div>
      </Panel>

      {/* Saved configs */}
      {configs.length > 0 && (
        <Panel title="YOUR BROKER CONFIGS">
          <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {configs.map(cfg => {
              const isMt5 = cfg.broker_type === 'mt5direct' || cfg.broker_type === 'exness'
              const pending = (cfg.config as any)?.pendingOrders?.length ?? 0
              const lastSync = (cfg.config as any)?.updatedAt
              const minutesAgo = lastSync ? Math.floor((Date.now() - new Date(lastSync).getTime()) / 60000) : null
              const eaOnline = minutesAgo !== null && minutesAgo < 5
              return (
              <div key={cfg.id} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 14px', borderRadius: 3,
                background: cfg.is_active ? 'rgba(0,255,135,0.04)' : 'rgba(0,0,0,0.2)',
                border: `1px solid ${cfg.is_active ? 'rgba(0,255,135,0.2)' : 'var(--border)'}`,
              }}>
                <div style={{ flex: 1 }}>
                  <span style={{ fontWeight: 700, color: cfg.is_active ? '#00ff87' : 'var(--text-secondary)', fontSize: 14 }}>{cfg.label}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 8 }}>{cfg.broker_type.toUpperCase()}</span>
                  {isMt5 && (
                    <div style={{ marginTop: 4, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 10, color: eaOnline ? '#00ff87' : minutesAgo === null ? '#607080' : '#ff6060' }}>
                        {eaOnline ? '● EA online' : minutesAgo === null ? '○ EA never synced' : `○ EA last seen ${minutesAgo}m ago`}
                      </span>
                      {(cfg.config as any)?.login && (
                        <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'JetBrains Mono' }}>
                          #{(cfg.config as any).login}{(cfg.config as any).server ? ' · ' + (cfg.config as any).server : ''}
                        </span>
                      )}
                      {(cfg.config as any)?.balance && parseFloat((cfg.config as any).balance) > 0 && (
                        <span style={{ fontSize: 10, color: '#60c0ff', fontFamily: 'JetBrains Mono' }}>
                          {(cfg.config as any).currency || 'USD'} {parseFloat((cfg.config as any).balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      )}
                      {pending > 0 && (
                        <>
                          <span style={{ fontSize: 10, color: '#ffb800', fontFamily: 'JetBrains Mono' }}>
                            ⏳ {pending} order{pending > 1 ? 's' : ''} waiting for EA
                          </span>
                          <button
                            onClick={async () => {
                              await authFetch('/api/broker-config', { method: 'PATCH', body: JSON.stringify({ id: cfg.id }) })
                              onToast?.('Queue cleared', '#ffb800')
                              load()
                            }}
                            style={{ fontSize: 9, padding: '2px 8px', borderRadius: 2, cursor: 'pointer', background: 'none', border: '1px solid #ff6060', color: '#ff6060' }}
                          >Clear</button>
                        </>
                      )}
                    </div>
                  )}
                </div>
                {cfg.is_active && <span style={{ fontSize: 9, color: '#00ff87', fontWeight: 700, letterSpacing: 1 }}>ACTIVE</span>}
                {!cfg.is_active && (
                  <button onClick={() => setActive(cfg.id)} className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 12px' }}>
                    Set Active
                  </button>
                )}
                <button onClick={() => startEdit(cfg)} className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 12px' }}>Edit</button>
                <button onClick={() => deleteConfig(cfg.id)} style={{
                  padding: '4px 12px', borderRadius: 3, cursor: 'pointer', fontSize: 11, background: 'none',
                  border: '1px solid var(--border)', color: '#ff6060',
                }}>✕</button>
              </div>
            )
            })}
          </div>
        </Panel>
      )}

      {/* Edit / Add form */}
      {editing && (
        <Panel title={editing.id ? `EDIT — ${editing.label}` : `ADD ${(editing.broker_type || '').toUpperCase()} BROKER`} bright>
          <div style={{ padding: '14px 16px' }}>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, display: 'block', marginBottom: 6 }}>LABEL</label>
              <input
                value={editing.label || ''}
                onChange={e => setEditing(s => ({ ...s!, label: e.target.value }))}
                style={inputSt}
                placeholder="My FTMO Account"
              />
            </div>
            {(BROKER_INFO[editing.broker_type as BrokerKey]?.fields || []).map(f => (
              <div key={f.key} style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, display: 'block', marginBottom: 6 }}>
                  {f.label.toUpperCase()}
                  {f.secret && <span style={{ marginLeft: 6, fontSize: 9, color: '#607080' }}>encrypted</span>}
                </label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={f.secret && !showSecrets ? 'password' : 'text'}
                    value={editing.config?.[f.key] || ''}
                    onChange={e => setEditing(s => ({ ...s!, config: { ...s!.config, [f.key]: e.target.value } }))}
                    placeholder={f.placeholder}
                    style={inputSt}
                  />
                </div>
              </div>
            ))}
            {(editing.broker_type === 'mt5direct' || editing.broker_type === 'exness') && editing.config?.webhookToken && (() => {
              const webhookUrl = `https://forex.sybexdesigns.co.uk/api/mt5-sync?token=${editing.config.webhookToken}`
              const eaCode = `//+------------------------------------------------------------------+
//| SybexForexAI Sync EA — MQL5 (MT5 native)                         |
//+------------------------------------------------------------------+
#include <Trade\\Trade.mqh>

input string WebhookURL     = "${webhookUrl}";
input int    BalanceSyncSec = 30;
input int    OrderPollSec   = 5;

CTrade       trade;
datetime     lastBalance = 0;
datetime     lastPoll    = 0;
string       completedJson = "";

int OnInit() {
   trade.SetExpertMagicNumber(202501);
   EventSetTimer(1);
   Print("SybexAI EA started. Webhook: ", WebhookURL);
   return INIT_SUCCEEDED;
}
void OnDeinit(const int) { EventKillTimer(); Print("SybexAI EA stopped."); }

void OnTimer() {
   datetime now = TimeCurrent();
   if(now - lastPoll    >= OrderPollSec)    { PollAndExecute(); lastPoll    = now; }
   if(now - lastBalance >= BalanceSyncSec)  { SendBalance();    lastBalance = now; }
}

//--- Build open positions JSON array
string BuildPositionsJson() {
   string posJson = "";
   int total = PositionsTotal();
   for(int i = 0; i < total; i++) {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      string sym    = PositionGetString(POSITION_SYMBOL);
      string type   = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "BUY" : "SELL");
      double lots   = PositionGetDouble(POSITION_VOLUME);
      double open   = PositionGetDouble(POSITION_PRICE_OPEN);
      double profit = PositionGetDouble(POSITION_PROFIT);
      if(posJson != "") posJson += ",";
      posJson += StringFormat(
         "{\\"ticket\\":%d,\\"symbol\\":\\"%s\\",\\"type\\":\\"%s\\",\\"lots\\":%.2f,\\"openPrice\\":%.5f,\\"profit\\":%.2f}",
         (int)ticket, sym, type, lots, open, profit
      );
   }
   return posJson;
}

//--- Send balance + completed orders + open positions back to app
void SendBalance() {
   string posJson = BuildPositionsJson();
   string body = StringFormat(
      "{\\"balance\\":%.2f,\\"equity\\":%.2f,\\"currency\\":\\"%s\\",\\"login\\":\\"%d\\",\\"server\\":\\"%s\\",\\"completedOrders\\":[%s],\\"openPositions\\":[%s]}",
      AccountInfoDouble(ACCOUNT_BALANCE), AccountInfoDouble(ACCOUNT_EQUITY),
      AccountInfoString(ACCOUNT_CURRENCY), (int)AccountInfoInteger(ACCOUNT_LOGIN),
      AccountInfoString(ACCOUNT_SERVER), completedJson, posJson
   );
   completedJson = "";
   char post[], res[];
   string resHdr = "";
   StringToCharArray(body, post, 0, StringLen(body));
   int code = WebRequest("POST", WebhookURL, "Content-Type: application/json\\r\\n", 5000, post, res, resHdr);
   if(code != 200) Print("Balance sync failed. HTTP: ", code, " Error: ", GetLastError());
}

//--- Auto-detect broker filling mode for a symbol
ENUM_ORDER_TYPE_FILLING GetFilling(string symbol) {
   long modes = SymbolInfoInteger(symbol, SYMBOL_FILLING_MODE);
   if((modes & SYMBOL_FILLING_FOK) != 0) return ORDER_FILLING_FOK;
   if((modes & SYMBOL_FILLING_IOC) != 0) return ORDER_FILLING_IOC;
   return ORDER_FILLING_RETURN;
}

//--- Poll webhook and execute any pending orders / close commands
void PollAndExecute() {
   char data[], result[];
   string resHdr = "";
   ArrayResize(data, 0);
   int code = WebRequest("GET", WebhookURL, "", 5000, data, result, resHdr);
   if(code != 200) { Print("Poll failed. HTTP: ", code, " Error: ", GetLastError(), " — Is the URL added to Tools→Options→Expert Advisors→Allow WebRequest?"); return; }
   string resp = CharArrayToString(result);
   if(StringFind(resp, "\\"id\\"") < 0) return;
   Print("Orders found in queue — executing...");

   int pos = 0;
   while(true) {
      int idStart = StringFind(resp, "\\"id\\":\\"", pos);
      if(idStart < 0) break;
      idStart += 6;
      int idEnd = StringFind(resp, "\\"", idStart);
      if(idEnd < 0) break;
      string orderId = StringSubstr(resp, idStart, idEnd - idStart);

      // Detect order type: close commands have no "lots" field (lots==0)
      double lots = ExtractNum(resp, "\\"lots\\":", idStart);

      if(lots == 0) {
         // ── Close command ──
         string symbol = ExtractStr(resp, "\\"symbol\\":\\"", idStart);
         bool closed = false;
         string closeErr = "";
         if(StringLen(symbol) > 0 && SymbolSelect(symbol, true)) {
            int total = PositionsTotal();
            for(int i = total - 1; i >= 0; i--) {
               ulong ticket = PositionGetTicket(i);
               if(ticket == 0) continue;
               if(PositionGetString(POSITION_SYMBOL) == symbol) {
                  if(trade.PositionClose(ticket)) {
                     closed = true;
                     Print("Closed position ticket=", ticket, " symbol=", symbol);
                  } else {
                     closeErr = IntegerToString(trade.ResultRetcode());
                     Print("Close failed ticket=", ticket, " retcode=", trade.ResultRetcode());
                  }
               }
            }
            if(!closed && StringLen(closeErr) == 0) closeErr = "no_position_found";
         } else {
            closeErr = (StringLen(symbol) == 0 ? "no_symbol" : "symbol_not_in_marketwatch");
            Print("Close: symbol not found: ", symbol);
         }
         string entry = StringFormat(
            "{\\"id\\":\\"%s\\",\\"success\\":%s,\\"ticket\\":0,\\"filledPrice\\":0,\\"error\\":\\"%s\\"}",
            orderId, (closed ? "true" : "false"), closeErr
         );
         if(completedJson != "") completedJson += ",";
         completedJson += entry;
         pos = idEnd;
         continue;
      }

      // ── Regular buy/sell order ──
      string symbol    = ExtractStr(resp, "\\"symbol\\":\\"", idStart);
      string direction = ExtractStr(resp, "\\"direction\\":\\"", idStart);
      double slPips    = ExtractNum(resp, "\\"slPips\\":", idStart);
      double tpPips    = ExtractNum(resp, "\\"tpPips\\":", idStart);
      if(!SymbolSelect(symbol, true)) {
         Print("Symbol not found in Market Watch: ", symbol, " — check exact name in MT5 Market Watch (Ctrl+M)");
         pos = idEnd; continue;
      }
      ENUM_ORDER_TYPE type  = (direction == "BUY") ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
      double          price = (type == ORDER_TYPE_BUY)
                              ? SymbolInfoDouble(symbol, SYMBOL_ASK)
                              : SymbolInfoDouble(symbol, SYMBOL_BID);

      // Compute SL/TP from current live price so they are always valid at execution
      bool   isJPY   = StringFind(symbol, "JPY") >= 0;
      bool   isXAU   = StringFind(symbol, "XAU") >= 0;
      bool   isXAG   = StringFind(symbol, "XAG") >= 0;
      double pipSize = isJPY ? 0.01 : (isXAU ? 0.1 : (isXAG ? 0.01 : 0.0001));
      double sl = (type == ORDER_TYPE_BUY) ? price - slPips * pipSize : price + slPips * pipSize;
      double tp = (type == ORDER_TYPE_BUY) ? price + tpPips * pipSize : price - tpPips * pipSize;

      // Enforce broker minimum stop distance
      int    stopsLevel = (int)SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL);
      double point      = SymbolInfoDouble(symbol, SYMBOL_POINT);
      double minDist    = (stopsLevel + 5) * point;
      if(minDist > 0) {
         if(type == ORDER_TYPE_BUY) {
            if(price - sl < minDist) sl = price - minDist;
            if(tp - price < minDist) tp = price + minDist;
         } else {
            if(sl - price < minDist) sl = price + minDist;
            if(price - tp < minDist) tp = price - minDist;
         }
      }
      Print("Executing: ", direction, " ", lots, " ", symbol, " @ ", price,
            " SL=", sl, " TP=", tp, " minStopDist=", minDist);

      MqlTradeRequest req = {};
      MqlTradeResult  res = {};
      req.action       = TRADE_ACTION_DEAL;
      req.symbol       = symbol;
      req.volume       = lots;
      req.type         = type;
      req.price        = price;
      req.sl           = sl;
      req.tp           = tp;
      req.deviation    = 10;
      req.magic        = 202501;
      req.comment      = "SybexAI";
      req.type_filling = GetFilling(symbol);

      bool ok = OrderSend(req, res);
      if(ok) Print("Order executed: ", direction, " ", lots, " ", symbol, " ticket=", res.deal, " price=", res.price);
      else   Print("Order FAILED: ", direction, " ", lots, " ", symbol, " retcode=", res.retcode, " comment=", res.comment, " error=", GetLastError());
      string entry = StringFormat(
         "{\\"id\\":\\"%s\\",\\"success\\":%s,\\"ticket\\":%d,\\"filledPrice\\":%.5f,\\"error\\":\\"%s\\"}",
         orderId, (ok ? "true" : "false"), (int)res.deal, res.price,
         (ok ? "" : IntegerToString(GetLastError()))
      );
      if(completedJson != "") completedJson += ",";
      completedJson += entry;
      pos = idEnd;
   }
   if(completedJson != "") SendBalance();
}

string ExtractStr(string src, string key, int from) {
   int s = StringFind(src, key, from); if(s < 0) return "";
   s += StringLen(key);
   int e = StringFind(src, "\\"", s); if(e < 0) return "";
   return StringSubstr(src, s, e - s);
}
double ExtractNum(string src, string key, int from) {
   int s = StringFind(src, key, from); if(s < 0) return 0;
   s += StringLen(key);
   return StringToDouble(StringSubstr(src, s, 20));
}`
              return (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ padding: '12px 14px', background: 'rgba(0,255,135,0.04)', border: '1px solid rgba(0,255,135,0.2)', borderRadius: 3, fontSize: 12, color: '#80d0a0', marginBottom: 10 }}>
                    <div style={{ fontWeight: 700, marginBottom: 8, color: '#00ff87' }}>3-step setup — no MetaApi needed:</div>
                    <div style={{ marginBottom: 6 }}>1. Save this broker config first</div>
                    <div style={{ marginBottom: 6 }}>2. In MT5: <strong>Tools → Options → Expert Advisors → Allow WebRequest</strong> → add your app URL</div>
                    <div>3. Copy the EA code below into MT5 and attach it to any chart</div>
                  </div>
                  <label style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, display: 'block', marginBottom: 6 }}>WEBHOOK URL (add this in MT5 WebRequest allowed URLs)</label>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                    <input readOnly value={webhookUrl} style={{ ...inputSt, flex: 1, fontSize: 11, color: '#60c0ff' }} />
                    <button
                      onClick={() => { navigator.clipboard.writeText(webhookUrl); onToast?.('URL copied', '#00ff87') }}
                      className="btn btn-ghost" style={{ fontSize: 11, padding: '6px 12px', flexShrink: 0 }}
                    >Copy</button>
                  </div>
                  <label style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, display: 'block', marginBottom: 6 }}>MT5 EXPERT ADVISOR CODE</label>
                  <textarea
                    readOnly
                    value={eaCode}
                    rows={8}
                    style={{ ...inputSt, fontSize: 10, lineHeight: 1.5, resize: 'vertical', fontFamily: 'JetBrains Mono' }}
                  />
                  <button
                    onClick={() => { navigator.clipboard.writeText(eaCode); onToast?.('EA code copied', '#00ff87') }}
                    className="btn btn-ghost" style={{ fontSize: 11, padding: '6px 16px', marginTop: 6 }}
                  >Copy EA Code</button>
                </div>
              )
            })()}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button onClick={save} disabled={saving} className="btn" style={{ padding: '10px 24px', fontSize: 13 }}>
                {saving ? 'Saving…' : 'SAVE BROKER'}
              </button>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
                <input type="checkbox" checked={editing.is_active || false}
                  onChange={e => setEditing(s => ({ ...s!, is_active: e.target.checked }))} />
                Set as active broker
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer', marginLeft: 'auto' }}>
                <input type="checkbox" checked={showSecrets} onChange={e => setShowSecrets(e.target.checked)} />
                Show secrets
              </label>
              <button onClick={() => setEditing(null)} className="btn btn-ghost" style={{ fontSize: 12, padding: '8px 16px' }}>
                Cancel
              </button>
            </div>
          </div>
        </Panel>
      )}

      {/* Add new broker cards — only shown when no saved config, or user clicked Change Broker */}
      {!editing && (!hasSavedConfig || changingBroker) && (
        <Panel title="ADD BROKER">
          <div style={{ padding: '14px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
            {addBrokerKeys.map(key => {
              const info = BROKER_INFO[key]
              const isExness = key === 'exness'
              const isMt5 = key === 'mt5direct'
              return (
                <button key={key} onClick={() => startNew(key)} style={{
                  padding: '14px 16px', borderRadius: 4, cursor: 'pointer', textAlign: 'left',
                  background: isExness ? 'rgba(0,255,135,0.04)' : 'rgba(0,0,0,0.2)',
                  border: isExness ? '1px solid rgba(0,255,135,0.3)' : '1px solid var(--border)',
                  transition: 'all 0.15s',
                }}>
                  <div style={{ fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 15, color: '#90b0d0', marginBottom: 6 }}>
                    {info.name}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>{info.description}</div>
                  {isExness && (
                    <div style={{ marginTop: 6, fontSize: 10, color: '#00ff87', fontWeight: 700 }}>🔥 RECOMMENDED</div>
                  )}
                  {isMt5 && (
                    <>
                      <div style={{ marginTop: 6, fontSize: 10, color: '#ffb800', fontWeight: 700 }}>🏆 FTMO COMPATIBLE</div>
                      <div style={{ marginTop: 3, fontSize: 10, color: '#00ff87' }}>✓ No MetaApi required</div>
                    </>
                  )}
                  {info.demo && !isExness && (
                    <div style={{ marginTop: 6, fontSize: 10, color: '#60c0ff' }}>✓ Demo available</div>
                  )}
                </button>
              )
            })}
          </div>
        </Panel>
      )}

      {/* Change broker button — shown when user already has a saved config and not currently changing */}
      {!editing && hasSavedConfig && !changingBroker && (
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <button
            onClick={() => setChangingBroker(true)}
            className="btn btn-ghost"
            style={{ fontSize: 13, padding: '10px 28px', letterSpacing: 1 }}
          >
            CHANGE BROKER
          </button>
        </div>
      )}
    </div>
  )
}

const inputSt: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 3, boxSizing: 'border-box',
  background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)',
  color: 'var(--text-primary)', fontSize: 13, fontFamily: 'JetBrains Mono',
}
