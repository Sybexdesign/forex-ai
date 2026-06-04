//+------------------------------------------------------------------+
//| SybexForexAI Balance Sync EA v9.0                                |
//| Posts DIRECTLY to Supabase RPC -- bypasses Vercel entirely.      |
//| v5 fix: ORDER_FILLING_RETURN (IOC caused all orders to reject).  |
//| v6 fix: split fast order-poll (2s) from heavy data sync (10s)    |
//|         so scalp orders are picked up in ~2s instead of ~30s.    |
//| v7 add: modify_sl command (post-entry trade management layer)    |
//|         close command now uses ticket when available (precise)   |
//|         fixed: close/modify_sl no longer skipped by lots>0 guard |
//| v7.1 fix: SymbolSuffix input for brokers using .s/.m/.r suffixes |
//| v8 add: in-EA Profit Protection Layer (BE/partial/trail/decay)   |
//| v8.1 fix: 6 profit protection improvements                       |
//| v9 add: closedPositions reporting                                |
//|   When MT5 closes a trade (TP/SL/profit-protection/manual),      |
//|   the EA now detects the closure, reads P/L from deal history,   |
//|   and reports it in the next sync payload as closedPositions.    |
//|   The server uses this to mark DB trades WIN/LOSS and record      |
//|   pl_usd — fixing daily-loss tracking for auto-traded sessions.  |
//+------------------------------------------------------------------+
#property strict
#property description "SybexForexAI v9.0 -- closed position P/L reporting"

//--- Inputs -----------------------------------------------------------
input string WebhookToken        = "c4fdfa3e21314a9fbf57fd7b3ffa30c4";
input string SymbolSuffix        = "";   // broker symbol suffix, e.g. ".s" for Exness
input int    OrderPollSeconds    = 2;    // how often to check for new pending orders
input int    DataSyncSeconds     = 10;   // how often to push full market data
input int    CandleBars          = 200;
input int    CandleBarsHTF       = 100;
input int    MagicNumber         = 20260001;
input int    SlippagePoints      = 10;
input ENUM_ORDER_TYPE_FILLING FillMode = ORDER_FILLING_RETURN;

// v8.1 FIX - MIN HOLD TIME
input int    MinHoldSeconds      = 60;   // no BE / trail / decay until trade is this old

// v8.1 FIX - SPREAD + SESSION PROTECTION
input int    MaxSpreadPips       = 30;   // skip SL actions if spread exceeds this
input bool   UseRolloverFilter   = true; // skip actions during broker rollover 21:55-22:05

string SYMBOLS[] = {"EURUSD","GBPUSD","USDJPY","AUDUSD","XAUUSD","XAGUSD","USDCAD"};

//--- Constants --------------------------------------------------------
string SYNC_URL = "https://lfurosnmkwvqtlifggaa.supabase.co/rest/v1/rpc/mt5_webhook_sync";
string ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxmdXJvc25ta3d2cXRsaWZnZ2FhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3MjQ4MzEsImV4cCI6MjA5MzMwMDgzMX0.ZWxFA-D57GqObQM_jSQ2PvNbqfxPOY4YBd__XZiFeWA";

//--- Globals ----------------------------------------------------------
int    g_totalSymbols  = 0;
string g_completedJson = "[]";
int    g_syncCounter   = 0;
int    g_syncEveryN    = 5;

//+------------------------------------------------------------------+
//  v9: Closed Position Tracking                                      |
//  Snapshot open positions before each timer tick. On next tick,     |
//  compare to current list. Disappeared tickets are read from MT5    |
//  deal history to get actual P/L and close price.                   |
//+------------------------------------------------------------------+

struct PrevPos {
   ulong  ticket;
   string symbol;    // raw broker symbol (may include suffix)
   string direction; // "BUY" or "SELL"
   double openPrice;
   double lots;
};

PrevPos g_prevPos[];
int     g_prevPosCount = 0;
string  g_closedJson   = "[]";

//--- Save current open positions for comparison on next tick -------
void SnapshotOpenPositions()
{
   int n = PositionsTotal();
   if(ArrayResize(g_prevPos, MathMax(n, 1)) < 0) return;
   g_prevPosCount = 0;

   for(int i = 0; i < n; i++)
   {
      ulong t = PositionGetTicket(i);
      if(t == 0) continue;
      g_prevPos[g_prevPosCount].ticket    = t;
      g_prevPos[g_prevPosCount].symbol    = StripSuffix(PositionGetString(POSITION_SYMBOL));
      g_prevPos[g_prevPosCount].direction =
         (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) ? "BUY" : "SELL";
      g_prevPos[g_prevPosCount].openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      g_prevPos[g_prevPosCount].lots      = PositionGetDouble(POSITION_VOLUME);
      g_prevPosCount++;
   }
}

//--- Detect closed positions since last snapshot; build JSON --------
string BuildClosedPositionsJSON()
{
   if(g_prevPosCount == 0) return "[]";

   // Build current open ticket set
   int   curCount = PositionsTotal();
   ulong curTickets[];
   ArrayResize(curTickets, MathMax(curCount, 1));
   for(int i = 0; i < curCount; i++)
      curTickets[i] = PositionGetTicket(i);

   // Load deal history for last 20 minutes to find close deals
   HistorySelect(TimeCurrent() - 1200, TimeCurrent());
   int dealsTotal = HistoryDealsTotal();

   string out  = "[";
   bool   first = true;

   for(int i = 0; i < g_prevPosCount; i++)
   {
      // Still open?
      bool stillOpen = false;
      for(int j = 0; j < curCount; j++)
         if(curTickets[j] == g_prevPos[i].ticket) { stillOpen = true; break; }
      if(stillOpen) continue;

      ulong closedTicket = g_prevPos[i].ticket;

      // Scan deal history backwards for the closing deal (DEAL_ENTRY_OUT)
      for(int k = dealsTotal - 1; k >= 0; k--)
      {
         ulong dealTkt = HistoryDealGetTicket(k);
         if(dealTkt == 0) continue;

         // Match on position ID (= position ticket for market orders in MT5)
         if((ulong)HistoryDealGetInteger(dealTkt, DEAL_POSITION_ID) != closedTicket)
            continue;

         // Only interested in the closing leg
         if(HistoryDealGetInteger(dealTkt, DEAL_ENTRY) != DEAL_ENTRY_OUT)
            continue;

         // Net P/L: profit + commission + swap
         double pnl = HistoryDealGetDouble(dealTkt, DEAL_PROFIT)
                    + HistoryDealGetDouble(dealTkt, DEAL_COMMISSION)
                    + HistoryDealGetDouble(dealTkt, DEAL_SWAP);
         double closePrice = HistoryDealGetDouble(dealTkt, DEAL_PRICE);
         string sym        = g_prevPos[i].symbol;  // clean name (suffix already stripped)
         int    dp         = (int)SymbolInfoInteger(sym + SymbolSuffix, SYMBOL_DIGITS);
         if(dp == 0) dp    = 5; // fallback

         if(!first) out += ",";
         out += "{\"symbol\":\""     + sym                                    + "\""
              + ",\"type\":\""       + g_prevPos[i].direction                 + "\""
              + ",\"openPrice\":"    + DoubleToString(g_prevPos[i].openPrice, dp)
              + ",\"closePrice\":"   + DoubleToString(closePrice,             dp)
              + ",\"lots\":"         + DoubleToString(g_prevPos[i].lots,      2)
              + ",\"profit\":"       + DoubleToString(pnl,                    2)
              + "}";
         first = false;
         break; // found the close deal for this position
      }
   }

   return out + "]";
}

//+------------------------------------------------------------------+
//  Profit Protection Layer — state per open position (unchanged v8.1)|
//+------------------------------------------------------------------+

struct ProtState {
   ulong    ticket;
   double   origEntry;
   double   origSl;
   double   peakProfit;
   bool     beApplied;
   bool     partialLocked;
   datetime openedAt;
};

ProtState g_prot[];
int       g_protCount    = 0;
int       g_protCapacity = 0;

int FindProtState(ulong ticket)
{
   for(int i = 0; i < g_protCount; i++)
      if(g_prot[i].ticket == ticket) return i;
   return -1;
}

int EnsureProtState(ulong ticket, double entry, double sl)
{
   int i = FindProtState(ticket);
   if(i >= 0) return i;

   if(g_protCount >= g_protCapacity)
   {
      int newCap = (g_protCapacity == 0) ? 20 : g_protCapacity * 2;
      if(ArrayResize(g_prot, newCap) < 0)
      {
         Print("[pp] ERROR: ArrayResize failed, capacity=", g_protCapacity,
               " — cannot track ticket=", ticket);
         return -1;
      }
      g_protCapacity = newCap;
      Print("[pp] g_prot expanded to capacity=", g_protCapacity);
   }

   i = g_protCount++;
   g_prot[i].ticket        = ticket;
   g_prot[i].origEntry     = entry;
   g_prot[i].origSl        = sl;
   g_prot[i].peakProfit    = 0.0;
   g_prot[i].beApplied     = false;
   g_prot[i].partialLocked = false;
   g_prot[i].openedAt      = TimeCurrent();
   return i;
}

void PurgeClosedStates()
{
   for(int i = g_protCount - 1; i >= 0; i--)
   {
      bool open = false;
      for(int j = 0; j < PositionsTotal(); j++)
         if(PositionGetTicket(j) == g_prot[i].ticket) { open = true; break; }
      if(!open)
      {
         for(int k = i; k < g_protCount - 1; k++)
            g_prot[k] = g_prot[k + 1];
         g_protCount--;
      }
   }
}

string StripSuffix(string sym)
{
   int sufLen = StringLen(SymbolSuffix);
   if(sufLen == 0) return sym;
   int symLen = StringLen(sym);
   if(symLen > sufLen && StringSubstr(sym, symLen - sufLen) == SymbolSuffix)
      return StringSubstr(sym, 0, symLen - sufLen);
   return sym;
}

double CalcATR_M5(string symbol)
{
   MqlRates rates[];
   int copied = CopyRates(symbol, PERIOD_M5, 0, 15, rates);
   if(copied < 2) return 0.0;
   double sum = 0.0;
   int    cnt = 0;
   for(int i = 1; i < copied; i++)
   {
      double tr = MathMax(rates[i].high - rates[i].low,
                  MathMax(MathAbs(rates[i].high - rates[i-1].close),
                          MathAbs(rates[i].low  - rates[i-1].close)));
      sum += tr;
      cnt++;
   }
   return cnt > 0 ? sum / cnt : 0.0;
}

bool IsTrendSufficient(string symbol, bool isBuy)
{
   MqlRates r[];
   int n = CopyRates(symbol, PERIOD_M5, 0, 15, r);
   if(n < 10) return true;

   double atrRecent = 0.0, atrOlder = 0.0;
   for(int i = n - 3; i < n; i++)      atrRecent += r[i].high - r[i].low;
   for(int i = n - 8; i < n - 3; i++) atrOlder  += r[i].high - r[i].low;
   atrRecent /= 3.0;
   atrOlder  /= 5.0;
   if(atrOlder > 0.0 && atrRecent > atrOlder * 1.05) return true;

   double avg5 = 0.0, avg10 = 0.0;
   for(int i = n - 5;  i < n; i++) avg5  += r[i].close;
   for(int i = n - 10; i < n; i++) avg10 += r[i].close;
   avg5  /= 5.0;
   avg10 /= 10.0;
   bool aligned = isBuy ? (avg5 > avg10) : (avg5 < avg10);
   if(aligned) return true;

   return false;
}

double GetTrailMult(string sym)
{
   if(StringFind(sym, "XAU") >= 0) return 1.5;
   if(StringFind(sym, "XAG") >= 0) return 1.2;
   if(StringFind(sym, "JPY") >= 0) return 0.5;
   return 0.5;
}

double CalcTrailSL(string sym, bool isBuy, double midPx)
{
   double atr  = CalcATR_M5(sym);
   if(atr <= 0.0 || midPx <= 0.0) return 0.0;
   double mult = GetTrailMult(sym);
   return isBuy ? midPx - atr * mult : midPx + atr * mult;
}

double GetPipSize(string sym)
{
   if(StringFind(sym, "JPY") >= 0) return 0.01;
   if(StringFind(sym, "XAU") >= 0) return 0.1;
   if(StringFind(sym, "XAG") >= 0) return 0.001;
   return 0.0001;
}

bool IsHighSpread(string sym)
{
   double spread  = SymbolInfoDouble(sym, SYMBOL_ASK) - SymbolInfoDouble(sym, SYMBOL_BID);
   double pipSize = GetPipSize(sym);
   return pipSize > 0.0 && (spread / pipSize) > MaxSpreadPips;
}

bool IsRolloverTime()
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   if(dt.hour == 21 && dt.min >= 55) return true;
   if(dt.hour == 22 && dt.min <= 5)  return true;
   return false;
}

bool IsSafeToAct(string sym)
{
   if(UseRolloverFilter && IsRolloverTime()) return false;
   if(IsHighSpread(sym))                     return false;
   return true;
}

void RunProfitProtection()
{
   PurgeClosedStates();

   for(int i = 0; i < PositionsTotal(); i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;

      string sym      = PositionGetString(POSITION_SYMBOL);
      string rawSym   = StripSuffix(sym);
      bool   isBuy    = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
      double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      double currentSl = PositionGetDouble(POSITION_SL);
      double profit    = PositionGetDouble(POSITION_PROFIT);
      int    dp        = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);

      double midPx = isBuy ? SymbolInfoDouble(sym, SYMBOL_BID)
                           : SymbolInfoDouble(sym, SYMBOL_ASK);
      if(midPx <= 0.0) continue;

      int si = EnsureProtState(ticket, openPrice, currentSl);
      if(si < 0) continue;

      int holdSecs = (int)(TimeCurrent() - g_prot[si].openedAt);
      if(holdSecs < MinHoldSeconds) continue;

      if(!IsSafeToAct(sym)) continue;

      if(profit > g_prot[si].peakProfit)
         g_prot[si].peakProfit = profit;

      double origEntry = g_prot[si].origEntry;
      double origSl    = g_prot[si].origSl;
      double riskDist  = MathAbs(origEntry - origSl);
      if(riskDist < 0.000001) continue;

      double pnlDist = isBuy ? midPx - origEntry : origEntry - midPx;
      double rMult   = pnlDist / riskDist;

      double newSl   = 0.0;
      bool   doClose = false;

      if(!g_prot[si].beApplied && rMult >= 0.5)
      {
         bool improves = isBuy ? origEntry > currentSl : origEntry < currentSl;
         if(improves && IsTrendSufficient(sym, isBuy))
         {
            newSl = origEntry;
            g_prot[si].beApplied = true;
            Print("[pp] ", rawSym, "#", ticket, " BE: R=", DoubleToString(rMult, 2),
                  " → SL to entry ", DoubleToString(origEntry, dp));
         }
         else if(improves)
            Print("[pp] ", rawSym, "#", ticket, " BE skipped: R=", DoubleToString(rMult, 2), " — choppy market");
      }

      if(!g_prot[si].partialLocked && rMult >= 1.0)
      {
         g_prot[si].partialLocked = true;
         double lockSl   = isBuy ? origEntry + 0.5 * riskDist : origEntry - 0.5 * riskDist;
         double baseline = (newSl > 0.0) ? newSl : currentSl;
         bool   improves = isBuy ? lockSl > baseline : lockSl < baseline;
         if(improves)
         {
            newSl = lockSl;
            Print("[pp] ", rawSym, "#", ticket, " partial-lock: R=", DoubleToString(rMult, 2),
                  " → SL=", DoubleToString(lockSl, dp));
         }
      }

      double trailSl = CalcTrailSL(sym, isBuy, midPx);
      if(trailSl > 0.0)
      {
         bool inProfit = isBuy ? trailSl > origEntry : trailSl < origEntry;
         double baseline = (newSl > 0.0) ? newSl : currentSl;
         bool improves   = isBuy ? trailSl > baseline : trailSl < baseline;
         if(inProfit && improves)
         {
            newSl = trailSl;
            Print("[pp] ", rawSym, "#", ticket, " trail: px=", DoubleToString(midPx, dp),
                  " → SL=", DoubleToString(trailSl, dp));
         }
      }

      if(newSl > 0.0)
      {
         int rc = 0;
         if(!ModifySL(ticket, rawSym, NormalizeDouble(newSl, dp), rc))
            Print("[pp] ModifySL FAILED ", rawSym, " ticket=", ticket, " retcode=", rc);
      }

      double peak = g_prot[si].peakProfit;
      if(peak > 0.1 && profit < peak * 0.40)
      {
         Print("[pp] ", rawSym, "#", ticket, " DECAY-EXIT: profit=$", DoubleToString(profit, 2),
               " < 40% of peak=$", DoubleToString(peak, 2), " held=", holdSecs, "s");
         doClose = true;
      }

      if(doClose)
      {
         int rc = 0;
         if(!CloseByTicket(ticket, rawSym, rc))
            Print("[pp] CloseByTicket FAILED ", rawSym, " ticket=", ticket, " retcode=", rc);
      }
   }
}

//+------------------------------------------------------------------+
int OnInit()
{
   g_totalSymbols = ArraySize(SYMBOLS);
   g_syncEveryN   = MathMax(1, DataSyncSeconds / OrderPollSeconds);
   g_protCount    = 0;
   g_protCapacity = 0;
   ArrayResize(g_prot, 20);
   g_protCapacity = 20;

   // v9: take initial position snapshot
   g_prevPosCount = 0;
   ArrayResize(g_prevPos, 20);
   SnapshotOpenPositions();

   EventSetTimer(OrderPollSeconds);
   Print("SybexForexAI v9.0 started | FillMode=", EnumToString(FillMode),
         " | OrderPoll=", OrderPollSeconds, "s | DataSync=", DataSyncSeconds, "s",
         " | Suffix='", SymbolSuffix, "'",
         " | MinHold=", MinHoldSeconds, "s",
         " | MaxSpread=", MaxSpreadPips, "pip",
         " | Token prefix: ", StringSubstr(WebhookToken, 0, 8));
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { EventKillTimer(); }

//+------------------------------------------------------------------+
void OnTimer()
{
   // ── Profit Protection (every OrderPollSeconds, no server round-trip)
   RunProfitProtection();

   // ── v9: detect positions that closed since last snapshot ────────
   // Must run before SnapshotOpenPositions to capture the disappearance
   g_closedJson = BuildClosedPositionsJSON();

   // ── Fast path: always check for pending orders ──────────────────
   string resp = FetchPendingOrders();
   if(StringLen(resp) > 10)
   {
      int cnt = 0, sp = 0;
      while(StringFind(resp, "\"id\":", sp) >= 0) { sp = StringFind(resp,"\"id\":",sp)+1; cnt++; }
      if(cnt > 0)
      {
         Print("SybexForexAI v9.0: ", cnt, " pending command(s) -- executing...");
         g_completedJson = ExecuteOrders(resp);
         Print("SybexForexAI v9.0: completedOrders=", g_completedJson);
      }
   }

   // ── Slow path: full data push every DataSyncSeconds ─────────────
   bool ordersJustFilled = (g_completedJson != "[]");
   bool hadClosures      = (g_closedJson    != "[]");

   g_syncCounter++;
   if(g_syncCounter >= g_syncEveryN || ordersJustFilled || hadClosures)
   {
      if(hadClosures)
         Print("SybexForexAI v9.0: reporting closed positions: ", g_closedJson);

      g_syncCounter   = 0;
      SendDataToApp();
      g_completedJson = "[]";

      // v9: take fresh snapshot AFTER sending so next tick's diff is accurate
      SnapshotOpenPositions();
   }
}

//+------------------------------------------------------------------+
string BuildHeaders()
{
   return "Content-Type: application/json\r\n"
        + "apikey: " + ANON_KEY + "\r\n"
        + "Authorization: Bearer " + ANON_KEY + "\r\n";
}

//+------------------------------------------------------------------+
string FetchPendingOrders()
{
   char post[], result[];
   string respHdr = "";
   string body = "{\"p_token\":\"" + WebhookToken + "\",\"p_payload\":null}";
   StringToCharArray(body, post, 0, StringLen(body));
   ArrayResize(post, StringLen(body));

   ResetLastError();
   int rc = WebRequest("POST", SYNC_URL, BuildHeaders(), 4000, post, result, respHdr);
   if(rc == -1)
   {
      Print("SybexForexAI v9.0: pull FAILED err=", GetLastError(),
            " -- add URL to Tools>Options>Expert Advisors>Allowed URLs");
      return "";
   }
   if(rc != 200)
   {
      Print("SybexForexAI v9.0: pull HTTP ", rc);
      return "";
   }
   return CharArrayToString(result);
}

//+------------------------------------------------------------------+
void SendDataToApp()
{
   string body = "{"
      + "\"p_token\":\"" + WebhookToken + "\","
      + "\"p_payload\":{"
      + "\"balance\":"           + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE),2)
      + ",\"equity\":"           + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY),2)
      + ",\"currency\":\""       + AccountInfoString(ACCOUNT_CURRENCY) + "\""
      + ",\"login\":\""          + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "\""
      + ",\"server\":\""         + AccountInfoString(ACCOUNT_SERVER) + "\""
      + ",\"prices\":"           + BuildPricesJSON()
      + ",\"candles\":"          + BuildCandlesJSON()
      + ",\"openPositions\":"    + BuildOpenPositionsJSON()
      + ",\"completedOrders\":"  + g_completedJson
      + ",\"closedPositions\":"  + g_closedJson
      + "}}";

   char post[], result[];
   string respHdr = "";
   StringToCharArray(body, post, 0, StringLen(body));
   ArrayResize(post, StringLen(body));

   ResetLastError();
   int rc = WebRequest("POST", SYNC_URL, BuildHeaders(), 15000, post, result, respHdr);
   if(rc == -1)
      Print("SybexForexAI v9.0: push FAILED err=", GetLastError());
   else if(rc == 200)
      Print("SybexForexAI v9.0: push OK | Bal=",
            DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE),2),
            " Pos=", PositionsTotal(),
            " Closed=", (g_closedJson != "[]" ? g_closedJson : "none"));
   else
      Print("SybexForexAI v9.0: push HTTP ", rc, " -- ", StringSubstr(CharArrayToString(result),0,200));
}

//+------------------------------------------------------------------+
string JsonStr(string j, string key)
{
   string s = "\"" + key + "\":";
   int p = StringFind(j, s);
   if(p < 0) return "";
   p += StringLen(s);
   while(StringGetCharacter(j,p) == 32) p++;
   if(StringGetCharacter(j,p) != '"') return "";
   p++;
   int e = StringFind(j, "\"", p);
   return e < 0 ? "" : StringSubstr(j, p, e-p);
}

double JsonNum(string j, string key)
{
   string s = "\"" + key + "\":";
   int p = StringFind(j, s);
   if(p < 0) return 0;
   p += StringLen(s);
   while(StringGetCharacter(j,p) == 32) p++;
   return StringToDouble(StringSubstr(j, p, 30));
}

//+------------------------------------------------------------------+
string BuildPricesJSON()
{
   string out = "{";
   bool first = true;
   for(int i = 0; i < g_totalSymbols; i++)
   {
      string fullSym = SYMBOLS[i] + SymbolSuffix;
      double bid = SymbolInfoDouble(fullSym, SYMBOL_BID);
      double ask = SymbolInfoDouble(fullSym, SYMBOL_ASK);
      if(bid <= 0 || ask <= 0) continue;
      int dp = (int)SymbolInfoInteger(fullSym, SYMBOL_DIGITS);
      if(!first) out += ",";
      out += "\"" + SYMBOLS[i] + "\":{\"bid\":" + DoubleToString(bid,dp)
           + ",\"ask\":" + DoubleToString(ask,dp) + "}";
      first = false;
   }
   return out + "}";
}

//+------------------------------------------------------------------+
string BuildCandleArray(string symbol, ENUM_TIMEFRAMES period, int bars)
{
   MqlRates rates[];
   int copied = CopyRates(symbol, period, 0, bars, rates);
   if(copied <= 0) return "[]";
   int dp = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   string out = "[";
   for(int i = 0; i < copied; i++)
   {
      if(i > 0) out += ",";
      out += "{\"t\":" + IntegerToString((long)rates[i].time)
           + ",\"o\":" + DoubleToString(rates[i].open,  dp)
           + ",\"h\":" + DoubleToString(rates[i].high,  dp)
           + ",\"l\":" + DoubleToString(rates[i].low,   dp)
           + ",\"c\":" + DoubleToString(rates[i].close, dp)
           + ",\"v\":" + IntegerToString((long)rates[i].tick_volume) + "}";
   }
   return out + "]";
}

string BuildCandlesForTF(ENUM_TIMEFRAMES period, int bars)
{
   string out = "{";
   bool first = true;
   for(int i = 0; i < g_totalSymbols; i++)
   {
      string fullSym = SYMBOLS[i] + SymbolSuffix;
      string arr = BuildCandleArray(fullSym, period, bars);
      if(arr == "[]") continue;
      if(!first) out += ",";
      out += "\"" + SYMBOLS[i] + "\":" + arr;  // key is always the clean name
      first = false;
   }
   return out + "}";
}

string BuildCandlesJSON()
{
   return "{"
      + "\"M5\":"   + BuildCandlesForTF(PERIOD_M5,  CandleBars)
      + ",\"M15\":" + BuildCandlesForTF(PERIOD_M15, CandleBarsHTF)
      + ",\"H1\":"  + BuildCandlesForTF(PERIOD_H1,  CandleBarsHTF)
      + ",\"H4\":"  + BuildCandlesForTF(PERIOD_H4,  50)
      + "}";
}

string BuildOpenPositionsJSON()
{
   string out = "[";
   bool first = true;
   for(int i = 0; i < PositionsTotal(); i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(!first) out += ",";
      out += "{"
           + "\"ticket\":"     + IntegerToString((long)ticket)
           + ",\"symbol\":\""  + StripSuffix(PositionGetString(POSITION_SYMBOL)) + "\""
           + ",\"type\":\""    + (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "BUY" : "SELL") + "\""
           + ",\"lots\":"      + DoubleToString(PositionGetDouble(POSITION_VOLUME),2)
           + ",\"openPrice\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN),5)
           + ",\"sl\":"        + DoubleToString(PositionGetDouble(POSITION_SL),5)
           + ",\"tp\":"        + DoubleToString(PositionGetDouble(POSITION_TP),5)
           + ",\"profit\":"    + DoubleToString(PositionGetDouble(POSITION_PROFIT),2)
           + "}";
      first = false;
   }
   return out + "]";
}

//+------------------------------------------------------------------+
bool PlaceOrder(string symbol, string direction, double lots,
                double slPrice, double tpPrice,
                double &filledPrice, int &retcode)
{
   string fullSym = symbol + SymbolSuffix;
   ENUM_ORDER_TYPE_FILLING modes[3];
   modes[0] = FillMode;
   modes[1] = ORDER_FILLING_FOK;
   modes[2] = ORDER_FILLING_IOC;

   for(int f = 0; f < 3; f++)
   {
      MqlTradeRequest req;
      MqlTradeResult  res;
      ZeroMemory(req);
      ZeroMemory(res);

      req.action       = TRADE_ACTION_DEAL;
      req.symbol       = fullSym;
      req.volume       = lots;
      req.type         = (direction == "BUY") ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
      req.price        = (direction == "BUY")
                         ? SymbolInfoDouble(fullSym, SYMBOL_ASK)
                         : SymbolInfoDouble(fullSym, SYMBOL_BID);
      req.sl           = slPrice;
      req.tp           = tpPrice;
      req.deviation    = SlippagePoints;
      req.magic        = MagicNumber;
      req.type_filling = modes[f];

      bool ok  = OrderSend(req, res);
      retcode  = (int)res.retcode;

      if(ok && res.retcode == 10009)
      {
         filledPrice = res.price;
         if(f > 0) Print("SybexForexAI v9.0: used fallback fill mode ", EnumToString(modes[f]));
         return true;
      }

      if(res.retcode != 10015 && res.retcode != 10030)
      {
         Print("SybexForexAI v9.0: order FAILED ", fullSym, " ", direction,
               " retcode=", res.retcode, " fill=", EnumToString(modes[f]));
         return false;
      }
      Print("SybexForexAI v9.0: fill mode ", EnumToString(modes[f]),
            " rejected -- trying next mode...");
   }
   return false;
}

//+------------------------------------------------------------------+
bool CloseByTicket(ulong ticket, string symbol, int &retcode)
{
   if(!PositionSelectByTicket(ticket)) return false;

   string fullSym = symbol + SymbolSuffix;
   MqlTradeRequest req;
   MqlTradeResult  res;
   ZeroMemory(req);
   ZeroMemory(res);

   ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
   req.action       = TRADE_ACTION_DEAL;
   req.symbol       = fullSym;
   req.volume       = PositionGetDouble(POSITION_VOLUME);
   req.type         = (posType == POSITION_TYPE_BUY) ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
   req.price        = (posType == POSITION_TYPE_BUY)
                      ? SymbolInfoDouble(fullSym, SYMBOL_BID)
                      : SymbolInfoDouble(fullSym, SYMBOL_ASK);
   req.deviation    = SlippagePoints;
   req.magic        = MagicNumber;
   req.position     = ticket;
   req.type_filling = FillMode;

   bool ok = OrderSend(req, res);
   retcode = (int)res.retcode;
   return ok && res.retcode == 10009;
}

//+------------------------------------------------------------------+
bool ModifySL(ulong ticket, string symbol, double newSl, int &retcode)
{
   if(!PositionSelectByTicket(ticket)) return false;

   MqlTradeRequest req;
   MqlTradeResult  res;
   ZeroMemory(req);
   ZeroMemory(res);

   req.action   = TRADE_ACTION_SLTP;
   req.symbol   = symbol + SymbolSuffix;
   req.sl       = newSl;
   req.tp       = PositionGetDouble(POSITION_TP);
   req.position = ticket;

   bool ok = OrderSend(req, res);
   retcode = (int)res.retcode;
   return ok && res.retcode == 10009;
}

//+------------------------------------------------------------------+
string ExecuteOrders(string response)
{
   string completed = "[";
   bool   first     = true;

   int pos = StringFind(response, "\"pendingOrders\"");
   if(pos < 0) return "[]";

   int arrStart = StringFind(response, "[", pos);
   int arrEnd   = StringFind(response, "]", arrStart);
   if(arrStart < 0 || arrEnd < 0) return "[]";

   string arr       = StringSubstr(response, arrStart, arrEnd - arrStart + 1);
   int    searchPos = 0;

   while(true)
   {
      int objStart = StringFind(arr, "{", searchPos);
      if(objStart < 0) break;
      int objEnd = StringFind(arr, "}", objStart);
      if(objEnd < 0) break;

      string obj     = StringSubstr(arr, objStart, objEnd - objStart + 1);
      string orderId = JsonStr(obj, "id");
      string symbol  = JsonStr(obj, "symbol");

      bool isClose    = (StringFind(obj, "\"type\":\"close\"")     >= 0);
      bool isModifySl = (StringFind(obj, "\"type\":\"modify_sl\"") >= 0);
      double lots     = JsonNum(obj, "lots");

      if(StringLen(orderId) == 0 || StringLen(symbol) == 0)
      {
         searchPos = objEnd + 1;
         continue;
      }

      if(!first) completed += ",";

      // ── modify_sl ───────────────────────────────────────────────────
      if(isModifySl)
      {
         ulong  ticket = (ulong)JsonNum(obj, "ticket");
         double newSl  = JsonNum(obj, "newSl");
         int    rc     = 0;
         bool   ok     = false;

         if(ticket > 0 && newSl > 0)
            ok = ModifySL(ticket, symbol, newSl, rc);

         if(ok)
         {
            completed += "{\"id\":\"" + orderId + "\",\"success\":true,\"type\":\"modify_sl\""
                       + ",\"ticket\":" + IntegerToString((long)ticket)
                       + ",\"newSl\":"  + DoubleToString(newSl, 5) + "}";
            Print("SybexForexAI v9.0: SL modified ", symbol, " ticket=", ticket, " newSl=", newSl);
         }
         else
         {
            completed += "{\"id\":\"" + orderId + "\",\"success\":false,\"type\":\"modify_sl\""
                       + ",\"error\":\"retcode " + IntegerToString(rc) + "\"}";
            Print("SybexForexAI v9.0: modify_sl FAILED ", symbol, " ticket=", ticket, " retcode=", rc);
         }
      }

      // ── close ───────────────────────────────────────────────────────
      else if(isClose)
      {
         ulong cmdTicket = (ulong)JsonNum(obj, "ticket");
         int   rc        = 0;
         bool  ok        = false;

         if(cmdTicket > 0)
         {
            ok = CloseByTicket(cmdTicket, symbol, rc);
            if(!ok)
               Print("SybexForexAI v9.0: ticket close failed ticket=", cmdTicket,
                     " retcode=", rc, " -- falling back to symbol close");
         }

         if(!ok)
         {
            string fullSym = symbol + SymbolSuffix;
            for(int i = PositionsTotal()-1; i >= 0; i--)
            {
               ulong t = PositionGetTicket(i);
               if(t == 0) continue;
               if(PositionGetString(POSITION_SYMBOL) != fullSym) continue;
               int   rc2 = 0;
               if(!CloseByTicket(t, symbol, rc2))
                  Print("SybexForexAI v9.0: symbol close failed ticket=", t, " retcode=", rc2);
               else
                  ok = true;
            }
         }

         completed += "{\"id\":\"" + orderId + "\",\"success\":" + (ok ? "true" : "false")
                    + ",\"type\":\"close\"}";
         Print("SybexForexAI v9.0: close ", (ok ? "OK" : "FAILED"), " ", symbol);
      }

      // ── new order ───────────────────────────────────────────────────
      else if(lots > 0)
      {
         string direction = JsonStr(obj, "direction");
         double slPrice   = JsonNum(obj, "slPrice");
         double tpPrice   = JsonNum(obj, "tpPrice");
         double filledPrice = 0;
         int    retcode     = 0;
         bool   ok = PlaceOrder(symbol, direction, lots, slPrice, tpPrice, filledPrice, retcode);

         if(ok)
         {
            completed += "{\"id\":\"" + orderId + "\",\"success\":true"
                       + ",\"filledPrice\":" + DoubleToString(filledPrice,5) + "}";
            Print("SybexForexAI v9.0: FILLED ", symbol, " ", direction,
                  " lots=", lots, " @ ", filledPrice);
         }
         else
         {
            completed += "{\"id\":\"" + orderId + "\",\"success\":false"
                       + ",\"error\":\"retcode " + IntegerToString(retcode) + "\"}";
            Print("SybexForexAI v9.0: REJECTED ", symbol, " retcode=", retcode);
         }
      }
      else
      {
         completed += "{\"id\":\"" + orderId + "\",\"success\":false"
                    + ",\"error\":\"unknown command type\"}";
         Print("SybexForexAI v9.0: unknown command in ", StringSubstr(obj,0,80));
      }

      first     = false;
      searchPos = objEnd + 1;
   }
   return completed + "]";
}
