//+------------------------------------------------------------------+
//| SybexForexAI Balance Sync EA v2                                   |
//| Pushes: balance, equity, prices, and M5 candles to the app.      |
//| The app uses this data for real-time indicators and AI signals.   |
//+------------------------------------------------------------------+
#property strict
#property description "SybexForexAI - pushes live prices and candles to your ForexAI dashboard"

//── Inputs ────────────────────────────────────────────────────────────
input string WebhookURL       = "https://forex.sybexdesigns.co.uk/api/mt5-sync?token=YOUR_TOKEN";
input int    SyncEverySeconds = 30;    // How often to push (seconds)
input int    CandleBars       = 200;   // Historical bars to push (keep ≤ 200)

// Pairs to monitor — add or remove to match what you trade.
// Use EXACT symbol names from your broker (e.g. EURUSDm if your broker uses a suffix).
string SYMBOLS[] = {"EURUSD","GBPUSD","USDJPY","AUDUSD","XAUUSD","USDCAD"};

//── Globals ───────────────────────────────────────────────────────────
int    g_totalSymbols = 0;

int OnInit() {
   g_totalSymbols = ArraySize(SYMBOLS);
   EventSetTimer(SyncEverySeconds);
   Print("SybexForexAI EA v2 started — syncing every ", SyncEverySeconds, "s");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) {
   EventKillTimer();
}

void OnTimer() {
   SendDataToApp();
}

//+------------------------------------------------------------------+
//| Build JSON for current bid/ask prices of all symbols              |
//+------------------------------------------------------------------+
string BuildPricesJSON() {
   string out = "{";
   bool first = true;
   for (int i = 0; i < g_totalSymbols; i++) {
      string sym = SYMBOLS[i];
      double bid = SymbolInfoDouble(sym, SYMBOL_BID);
      double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
      if (bid <= 0.0) continue;
      int dp = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      string fmt = "%." + IntegerToString(dp) + "f";
      if (!first) out += ",";
      out += "\"" + sym + "\":{\"bid\":" + DoubleToString(bid, dp) + ",\"ask\":" + DoubleToString(ask, dp) + "}";
      first = false;
   }
   out += "}";
   return out;
}

//+------------------------------------------------------------------+
//| Build JSON for OHLCV candles for one symbol                       |
//+------------------------------------------------------------------+
string BuildCandleArray(string symbol, int bars) {
   MqlRates rates[];
   int copied = CopyRates(symbol, PERIOD_M5, 0, bars, rates);
   if (copied <= 0) return "[]";

   int dp = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   string out = "[";
   for (int i = 0; i < copied; i++) {
      if (i > 0) out += ",";
      // Compact format: {t,o,h,l,c,v} — parsed by the server
      out += "{\"t\":" + IntegerToString((long)rates[i].time)
           + ",\"o\":" + DoubleToString(rates[i].open,  dp)
           + ",\"h\":" + DoubleToString(rates[i].high,  dp)
           + ",\"l\":" + DoubleToString(rates[i].low,   dp)
           + ",\"c\":" + DoubleToString(rates[i].close, dp)
           + ",\"v\":" + IntegerToString((long)rates[i].tick_volume)
           + "}";
   }
   out += "]";
   return out;
}

//+------------------------------------------------------------------+
//| Build JSON for candles of all symbols (M5 timeframe)              |
//+------------------------------------------------------------------+
string BuildCandlesJSON() {
   string data = "{";
   bool first = true;
   for (int i = 0; i < g_totalSymbols; i++) {
      string arr = BuildCandleArray(SYMBOLS[i], CandleBars);
      if (arr == "[]") continue;
      if (!first) data += ",";
      data += "\"" + SYMBOLS[i] + "\":" + arr;
      first = false;
   }
   data += "}";
   return "{\"timeframe\":\"M5\",\"data\":" + data + "}";
}

//+------------------------------------------------------------------+
//| Assemble full payload and send via WebRequest                     |
//+------------------------------------------------------------------+
void SendDataToApp() {
   string prices  = BuildPricesJSON();
   string candles = BuildCandlesJSON();

   string body = "{"
      + "\"balance\":"  + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2)
      + ",\"equity\":"  + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY),  2)
      + ",\"currency\":\"" + AccountInfoString(ACCOUNT_CURRENCY) + "\""
      + ",\"login\":\""    + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "\""
      + ",\"server\":\""   + AccountInfoString(ACCOUNT_SERVER) + "\""
      + ",\"prices\":"  + prices
      + ",\"candles\":" + candles
      + "}";

   string headers = "Content-Type: application/json\r\n";
   char post[], result[];
   StringToCharArray(body, post, 0, StringLen(body));

   ResetLastError();
   int res = WebRequest("POST", WebhookURL, headers, 10000, post, result);
   if (res == -1) {
      int err = GetLastError();
      Print("SybexForexAI sync FAILED (error ", err, "). Add ", WebhookURL, " to Tools→Options→Expert Advisors→Allowed URLs");
   } else {
      string resp = CharArrayToString(result);
      Print("SybexForexAI sync OK — Balance: ", DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2),
            " | Pairs: ", g_totalSymbols,
            " | Candles: M5×", CandleBars,
            " | HTTP: ", res);
   }
}
