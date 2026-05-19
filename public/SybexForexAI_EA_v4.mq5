//+------------------------------------------------------------------+
//| SybexForexAI Balance Sync EA v4                                   |
//| Posts DIRECTLY to Supabase — bypasses Vercel edge entirely.       |
//| Fixes intermittent HTTP 403 that affected v3.                     |
//+------------------------------------------------------------------+
#property strict
#property description "SybexForexAI v4 — direct Supabase sync (stable connection)"

//── Inputs ────────────────────────────────────────────────────────────
input string WebhookToken    = "YOUR_TOKEN_HERE";    // Paste from Broker page
input int    SyncEverySeconds = 30;
input int    CandleBars       = 200;
input int    MagicNumber      = 20260001;
input int    SlippagePoints   = 10;
input ENUM_ORDER_TYPE_FILLING FillMode = ORDER_FILLING_IOC;

// Pairs to monitor — must be valid symbols on your broker
string SYMBOLS[] = {"EURUSD","GBPUSD","USDJPY","AUDUSD","XAUUSD","XAGUSD","USDCAD"};

//── Constants — do NOT change these ──────────────────────────────────
// Supabase RPC endpoint (bypasses Vercel, no edge protection)
string SYNC_URL  = "https://lfurosnmkwvqtlifggaa.supabase.co/rest/v1/rpc/mt5_webhook_sync";
string ANON_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxmdXJvc25ta3d2cXRsaWZnZ2FhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3MjQ4MzEsImV4cCI6MjA5MzMwMDgzMX0.ZWxFA-D57GqObQM_jSQ2PvNbqfxPOY4YBd__XZiFeWA";

//── Globals ───────────────────────────────────────────────────────────
int    g_totalSymbols  = 0;
string g_completedJson = "[]";

int OnInit() {
   g_totalSymbols = ArraySize(SYMBOLS);
   EventSetTimer(SyncEverySeconds);
   if (WebhookToken == "YOUR_TOKEN_HERE") {
      Print("SybexForexAI v4: WARNING — token not set. Edit Inputs and paste your Webhook Token.");
   } else {
      Print("SybexForexAI EA v4 started — direct Supabase sync every ", SyncEverySeconds, "s");
      Print("Token prefix: ", StringSubstr(WebhookToken, 0, 8), "...");
   }
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { EventKillTimer(); }

void OnTimer() {
   // 1. Pull pending orders
   string resp = FetchPendingOrders();
   if (StringLen(resp) > 10) {
      // Count pending orders for diagnostics
      int orderCount = 0;
      int searchPos = 0;
      while (StringFind(resp, "\"id\":", searchPos) >= 0) {
         searchPos = StringFind(resp, "\"id\":", searchPos) + 1;
         orderCount++;
      }
      if (orderCount > 0)
         Print("SybexForexAI v4: ", orderCount, " pending order(s) received — executing...");
      else
         Print("SybexForexAI v4: pull OK — no pending orders");
      g_completedJson = ExecuteOrders(resp);
   }

   // 2. Push data
   SendDataToApp();
   g_completedJson = "[]";
}

//+------------------------------------------------------------------+
//| Build headers for Supabase REST API                               |
//+------------------------------------------------------------------+
string BuildHeaders() {
   return "Content-Type: application/json\r\n"
        + "apikey: " + ANON_KEY + "\r\n"
        + "Authorization: Bearer " + ANON_KEY + "\r\n";
}

//+------------------------------------------------------------------+
//| Pull pending orders via RPC                                       |
//+------------------------------------------------------------------+
string FetchPendingOrders() {
   string headers     = BuildHeaders();
   string respHeaders = "";
   char   post[], result[];
   // Pull = no balance in payload
   string body = "{\"p_token\":\"" + WebhookToken + "\",\"p_payload\":null}";
   StringToCharArray(body, post, 0, StringLen(body));
   ArrayResize(post, StringLen(body)); // strip null terminator added by StringToCharArray

   ResetLastError();
   int res = WebRequest("POST", SYNC_URL, headers, 10000, post, result, respHeaders);
   if (res == -1) {
      Print("SybexForexAI v4: pull FAILED (err=", GetLastError(),
            ") — ensure ", SYNC_URL, " is in Allowed URLs");
      return "";
   }
   if (res != 200) {
      Print("SybexForexAI v4: pull HTTP ", res, " — ", StringSubstr(CharArrayToString(result), 0, 200));
      return "";
   }
   return CharArrayToString(result);
}

//+------------------------------------------------------------------+
//| Push balance + market data to Supabase                            |
//+------------------------------------------------------------------+
void SendDataToApp() {
   string pricesJson  = BuildPricesJSON();
   string candlesJson = BuildCandlesJSON();

   string body = "{"
      + "\"p_token\":\"" + WebhookToken + "\","
      + "\"p_payload\":{"
      + "\"balance\":"         + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2)
      + ",\"equity\":"         + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY),  2)
      + ",\"currency\":\""     + AccountInfoString(ACCOUNT_CURRENCY)                  + "\""
      + ",\"login\":\""        + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))   + "\""
      + ",\"server\":\""       + AccountInfoString(ACCOUNT_SERVER)                    + "\""
      + ",\"prices\":"         + pricesJson
      + ",\"candles\":"        + candlesJson
      + ",\"openPositions\":"  + BuildOpenPositionsJSON()
      + ",\"completedOrders\":" + g_completedJson
      + "}}";

   string headers     = BuildHeaders();
   string respHeaders = "";
   char   post[], result[];
   StringToCharArray(body, post, 0, StringLen(body));
   ArrayResize(post, StringLen(body)); // strip null terminator

   ResetLastError();
   int res = WebRequest("POST", SYNC_URL, headers, 15000, post, result, respHeaders);
   if (res == -1) {
      Print("SybexForexAI v4 sync FAILED (err=", GetLastError(),
            ") — ensure ", SYNC_URL, " is in Allowed URLs");
   } else if (res == 200) {
      Print("SybexForexAI v4 sync OK"
            " | Balance: ", DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2),
            " | Pairs: ",   g_totalSymbols,
            " | Pos: ",     PositionsTotal());
   } else {
      Print("SybexForexAI v4 sync HTTP ", res,
            " — ", StringSubstr(CharArrayToString(result), 0, 200));
   }
}

//+------------------------------------------------------------------+
//| JSON helpers                                                      |
//+------------------------------------------------------------------+
string JsonStr(string j, string key) {
   string s = "\"" + key + "\":\"";
   int p = StringFind(j, s);
   if (p < 0) return "";
   p += StringLen(s);
   int e = StringFind(j, "\"", p);
   return e < 0 ? "" : StringSubstr(j, p, e - p);
}

double JsonNum(string j, string key) {
   string s = "\"" + key + "\":";
   int p = StringFind(j, s);
   if (p < 0) return 0;
   p += StringLen(s);
   string rest = StringSubstr(j, p, 30);
   return StringToDouble(rest);
}

//+------------------------------------------------------------------+
//| Build prices JSON                                                 |
//+------------------------------------------------------------------+
string BuildPricesJSON() {
   string out   = "{";
   bool   first = true;
   for (int i = 0; i < g_totalSymbols; i++) {
      double bid = SymbolInfoDouble(SYMBOLS[i], SYMBOL_BID);
      double ask = SymbolInfoDouble(SYMBOLS[i], SYMBOL_ASK);
      if (bid <= 0 || ask <= 0) continue;
      int dp = (int)SymbolInfoInteger(SYMBOLS[i], SYMBOL_DIGITS);
      if (!first) out += ",";
      out += "\"" + SYMBOLS[i] + "\":{\"bid\":" + DoubleToString(bid, dp)
           + ",\"ask\":" + DoubleToString(ask, dp) + "}";
      first = false;
   }
   return out + "}";
}

//+------------------------------------------------------------------+
//| Build candle array for one symbol                                 |
//+------------------------------------------------------------------+
string BuildCandleArray(string symbol, int bars) {
   MqlRates rates[];
   int copied = CopyRates(symbol, PERIOD_M5, 0, bars, rates);
   if (copied <= 0) return "[]";
   int    dp  = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   string out = "[";
   for (int i = 0; i < copied; i++) {
      if (i > 0) out += ",";
      out += "{\"t\":" + IntegerToString((long)rates[i].time)
           + ",\"o\":" + DoubleToString(rates[i].open,  dp)
           + ",\"h\":" + DoubleToString(rates[i].high,  dp)
           + ",\"l\":" + DoubleToString(rates[i].low,   dp)
           + ",\"c\":" + DoubleToString(rates[i].close, dp)
           + ",\"v\":" + IntegerToString((long)rates[i].tick_volume) + "}";
   }
   return out + "]";
}

//+------------------------------------------------------------------+
//| Build candles JSON (M5, all symbols)                              |
//+------------------------------------------------------------------+
string BuildCandlesJSON() {
   string data  = "{";
   bool   first = true;
   for (int i = 0; i < g_totalSymbols; i++) {
      string arr = BuildCandleArray(SYMBOLS[i], CandleBars);
      if (arr == "[]") continue;
      if (!first) data += ",";
      data += "\"" + SYMBOLS[i] + "\":" + arr;
      first = false;
   }
   return "{\"timeframe\":\"M5\",\"data\":" + data + "}}";
}

//+------------------------------------------------------------------+
//| Build open positions JSON                                         |
//+------------------------------------------------------------------+
string BuildOpenPositionsJSON() {
   string out   = "[";
   bool   first = true;
   for (int i = 0; i < PositionsTotal(); i++) {
      ulong ticket = PositionGetTicket(i);
      if (ticket == 0) continue;
      if (!first) out += ",";
      out += "{"
           + "\"ticket\":"    + IntegerToString((long)ticket)
           + ",\"symbol\":\"" + PositionGetString(POSITION_SYMBOL) + "\""
           + ",\"type\":\""   + (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "BUY" : "SELL") + "\""
           + ",\"lots\":"     + DoubleToString(PositionGetDouble(POSITION_VOLUME), 2)
           + ",\"openPrice\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), 5)
           + ",\"sl\":"       + DoubleToString(PositionGetDouble(POSITION_SL), 5)
           + ",\"tp\":"       + DoubleToString(PositionGetDouble(POSITION_TP), 5)
           + ",\"profit\":"   + DoubleToString(PositionGetDouble(POSITION_PROFIT), 2)
           + "}";
      first = false;
   }
   return out + "]";
}

//+------------------------------------------------------------------+
//| Execute pending orders received from server                       |
//+------------------------------------------------------------------+
string ExecuteOrders(string response) {
   string completed = "[";
   bool   first     = true;

   // Parse pendingOrders array — simple scan for "id" fields
   int pos = StringFind(response, "\"pendingOrders\"");
   if (pos < 0) return "[]";

   int arrStart = StringFind(response, "[", pos);
   int arrEnd   = StringFind(response, "]", arrStart);
   if (arrStart < 0 || arrEnd < 0) return "[]";

   string arr = StringSubstr(response, arrStart, arrEnd - arrStart + 1);

   int searchPos = 0;
   while (true) {
      int objStart = StringFind(arr, "{", searchPos);
      if (objStart < 0) break;

      int objEnd = StringFind(arr, "}", objStart);
      if (objEnd < 0) break;

      string obj       = StringSubstr(arr, objStart, objEnd - objStart + 1);
      string orderId   = JsonStr(obj, "id");
      string symbol    = JsonStr(obj, "symbol");
      string direction = JsonStr(obj, "direction");
      double lots      = JsonNum(obj, "lots");
      double slPrice   = JsonNum(obj, "slPrice");
      double tpPrice   = JsonNum(obj, "tpPrice");

      if (StringLen(orderId) > 0 && StringLen(symbol) > 0 && lots > 0) {
         // Check if it's a close command
         bool isClose = (StringFind(obj, "\"type\":\"close\"") >= 0);

         if (isClose) {
            // Close all positions for the symbol
            for (int i = PositionsTotal() - 1; i >= 0; i--) {
               ulong ticket = PositionGetTicket(i);
               if (ticket == 0) continue;
               if (PositionGetString(POSITION_SYMBOL) != symbol) continue;
               MqlTradeRequest req; MqlTradeResult  res2;
               ZeroMemory(req); ZeroMemory(res2);
               req.action   = TRADE_ACTION_DEAL;
               req.symbol   = symbol;
               req.volume   = PositionGetDouble(POSITION_VOLUME);
               req.type     = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY
                              ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
               req.price    = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY
                              ? SymbolInfoDouble(symbol, SYMBOL_BID)
                              : SymbolInfoDouble(symbol, SYMBOL_ASK);
               req.deviation = SlippagePoints;
               req.magic    = MagicNumber;
               req.position = ticket;
               req.type_filling = FillMode;
               OrderSend(req, res2);
            }
            if (!first) completed += ",";
            completed += "{\"id\":\"" + orderId + "\",\"success\":true,\"type\":\"close\"}";
            first = false;
         } else {
            // Place new order
            MqlTradeRequest req; MqlTradeResult  res2;
            ZeroMemory(req); ZeroMemory(res2);
            req.action    = TRADE_ACTION_DEAL;
            req.symbol    = symbol;
            req.volume    = lots;
            req.type      = (direction == "BUY") ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
            req.price     = (direction == "BUY")
                            ? SymbolInfoDouble(symbol, SYMBOL_ASK)
                            : SymbolInfoDouble(symbol, SYMBOL_BID);
            req.sl        = slPrice;
            req.tp        = tpPrice;
            req.deviation = SlippagePoints;
            req.magic     = MagicNumber;
            req.type_filling = FillMode;

            bool ok = OrderSend(req, res2);
            if (!first) completed += ",";
            if (ok && res2.retcode == TRADE_RETCODE_DONE) {
               completed += "{\"id\":\"" + orderId + "\",\"success\":true"
                          + ",\"filledPrice\":" + DoubleToString(res2.price, 5) + "}";
               Print("SybexForexAI v4: order filled — ", symbol, " ", direction,
                     " lots=", lots, " @ ", res2.price);
            } else {
               completed += "{\"id\":\"" + orderId + "\",\"success\":false"
                          + ",\"error\":\"retcode " + IntegerToString(res2.retcode) + "\"}";
               Print("SybexForexAI v4: order FAILED — ", symbol, " retcode=", res2.retcode);
            }
            first = false;
         }
      }
      searchPos = objEnd + 1;
   }
   return completed + "]";
}
