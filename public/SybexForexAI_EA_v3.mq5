//+------------------------------------------------------------------+
//| SybexForexAI Balance Sync EA v3                                   |
//| Pushes: balance, equity, prices, candles, open positions          |
//| Pulls:  pending orders and executes them with SL/TP in MT5        |
//+------------------------------------------------------------------+
#property strict
#property description "SybexForexAI v3 - live sync + auto order execution"

//── Inputs ────────────────────────────────────────────────────────────
input string WebhookURL       = "https://forex.sybexdesigns.co.uk/api/mt5-sync?token=YOUR_TOKEN";
input int    SyncEverySeconds = 30;
input int    CandleBars       = 200;
input int    MagicNumber      = 20260001;
input int    SlippagePoints   = 10;
input ENUM_ORDER_TYPE_FILLING FillMode = ORDER_FILLING_FOK; // Change to IOC if FOK fails on your broker

// Pairs to monitor — must be valid symbols on your broker
string SYMBOLS[] = {"EURUSD","GBPUSD","USDJPY","AUDUSD","XAUUSD","XAGUSD","USDCAD"};

//── Globals ───────────────────────────────────────────────────────────
int    g_totalSymbols  = 0;
string g_completedJson = "[]"; // filled orders to report in next POST

int OnInit() {
   g_totalSymbols = ArraySize(SYMBOLS);
   EventSetTimer(SyncEverySeconds);
   Print("SybexForexAI EA v3 started — syncing every ", SyncEverySeconds, "s");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { EventKillTimer(); }

void OnTimer() {
   // 1. Fetch pending orders and execute them
   string resp = FetchPendingOrders();
   if (StringLen(resp) > 10)
      g_completedJson = ExecuteOrders(resp);

   // 2. Push data (includes completedOrders report so server clears the queue)
   SendDataToApp();
   g_completedJson = "[]";
}

//+------------------------------------------------------------------+
//| GET /api/mt5-sync — returns pending orders from the app           |
//+------------------------------------------------------------------+
string FetchPendingOrders() {
   string headers = "", respHeaders = "";
   char   post[], result[];
   int    res = WebRequest("GET", WebhookURL, headers, 10000, post, result, respHeaders);
   if (res <= 0) {
      Print("SybexForexAI: GET failed (err=", GetLastError(), ")");
      return "";
   }
   return CharArrayToString(result);
}

//+------------------------------------------------------------------+
//| JSON helpers — extract "key":"value" or "key":number             |
//+------------------------------------------------------------------+
string JsonStr(string j, string key) {
   string s = "\"" + key + "\":\"";
   int p = StringFind(j, s);
   if (p < 0) return "";
   p += StringLen(s);
   int e = StringFind(j, "\"", p);
   return (e < 0) ? "" : StringSubstr(j, p, e - p);
}

double JsonNum(string j, string key) {
   string s = "\"" + key + "\":";
   int p = StringFind(j, s);
   if (p < 0) return 0.0;
   p += StringLen(s);
   int e = p;
   while (e < StringLen(j)) {
      ushort c = StringGetCharacter(j, e);
      if (c == ',' || c == '}' || c == ']') break;
      e++;
   }
   return StringToDouble(StringSubstr(j, p, e - p));
}

//+------------------------------------------------------------------+
//| Split a JSON array string into individual {…} objects             |
//+------------------------------------------------------------------+
int SplitObjects(string arr, string &out[], int maxOut) {
   int count = 0, pos = 0, len = StringLen(arr);
   while (pos < len && count < maxOut) {
      int start = StringFind(arr, "{", pos);
      if (start < 0) break;
      int depth = 1, p = start + 1;
      while (p < len && depth > 0) {
         ushort c = StringGetCharacter(arr, p);
         if (c == '{') depth++;
         else if (c == '}') depth--;
         p++;
      }
      if (depth == 0) { out[count++] = StringSubstr(arr, start, p - start); pos = p; }
      else break;
   }
   return count;
}

//+------------------------------------------------------------------+
//| Open a BUY or SELL market order with pre-calculated SL/TP         |
//+------------------------------------------------------------------+
bool OpenOrder(string symbol, string dir, double lots,
               double slPrice, double tpPrice, double &filledPrice) {
   ENUM_ORDER_TYPE type  = (dir == "BUY") ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   double          price = (type == ORDER_TYPE_BUY)
                           ? SymbolInfoDouble(symbol, SYMBOL_ASK)
                           : SymbolInfoDouble(symbol, SYMBOL_BID);
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);

   MqlTradeRequest req = {};
   MqlTradeResult  res = {};
   req.action       = TRADE_ACTION_DEAL;
   req.symbol       = symbol;
   req.volume       = lots;
   req.type         = type;
   req.price        = price;
   req.sl           = NormalizeDouble(slPrice, digits);
   req.tp           = NormalizeDouble(tpPrice, digits);
   req.deviation    = SlippagePoints;
   req.magic        = MagicNumber;
   req.comment      = "SybexForexAI";
   req.type_filling = FillMode;

   bool ok = OrderSend(req, res);
   filledPrice = (ok && res.retcode == TRADE_RETCODE_DONE) ? res.price : price;
   if (!ok) Print("SybexForexAI: OrderSend failed retcode=", res.retcode, " comment=", res.comment);
   return ok && res.retcode == TRADE_RETCODE_DONE;
}

//+------------------------------------------------------------------+
//| Close all positions on a symbol placed by this EA                 |
//+------------------------------------------------------------------+
bool CloseBySymbol(string symbol) {
   bool ok = true;
   for (int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong ticket = PositionGetTicket(i);
      if (!PositionSelectByTicket(ticket)) continue;
      if (PositionGetString(POSITION_SYMBOL) != symbol) continue;
      if (PositionGetInteger(POSITION_MAGIC)  != MagicNumber) continue;

      ENUM_ORDER_TYPE closeType = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY)
                                  ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
      MqlTradeRequest req = {};
      MqlTradeResult  res = {};
      req.action    = TRADE_ACTION_DEAL;
      req.symbol    = symbol;
      req.volume    = PositionGetDouble(POSITION_VOLUME);
      req.type      = closeType;
      req.price     = (closeType == ORDER_TYPE_SELL)
                      ? SymbolInfoDouble(symbol, SYMBOL_BID)
                      : SymbolInfoDouble(symbol, SYMBOL_ASK);
      req.position  = ticket;
      req.deviation = SlippagePoints;
      req.magic     = MagicNumber;
      req.type_filling = FillMode;
      if (!OrderSend(req, res) || res.retcode != TRADE_RETCODE_DONE) ok = false;
   }
   return ok;
}

//+------------------------------------------------------------------+
//| Parse pending orders JSON, execute each, return completedOrders   |
//+------------------------------------------------------------------+
string ExecuteOrders(string serverResp) {
   // Extract contents of "pendingOrders":[...]
   string key = "\"pendingOrders\":[";
   int start = StringFind(serverResp, key);
   if (start < 0) return "[]";
   start += StringLen(key);

   int depth = 1, pos = start, len = StringLen(serverResp);
   while (pos < len && depth > 0) {
      ushort c = StringGetCharacter(serverResp, pos);
      if (c == '[') depth++;
      else if (c == ']') depth--;
      pos++;
   }
   string arrStr = StringSubstr(serverResp, start, pos - start - 1);
   if (StringLen(arrStr) < 3) return "[]";

   string orders[50];
   int n = SplitObjects(arrStr, orders, 50);
   if (n == 0) return "[]";

   string completed = "[";
   bool   first     = true;

   for (int i = 0; i < n; i++) {
      string o  = orders[i];
      string id = JsonStr(o, "id");
      if (StringLen(id) == 0) continue;

      string otype  = JsonStr(o, "type");   // "close" or absent
      string symbol = JsonStr(o, "symbol");
      bool   isClose = (otype == "close");

      if (!first) completed += ",";
      first = false;

      if (isClose) {
         bool ok = CloseBySymbol(symbol);
         Print("SybexForexAI: CLOSE ", symbol, " → ", ok ? "OK" : "FAILED");
         completed += "{\"id\":\"" + id + "\",\"success\":" + (ok ? "true" : "false") + "}";

      } else {
         string dir     = JsonStr(o, "direction");
         double lots    = JsonNum(o, "lots");
         double slPrice = JsonNum(o, "slPrice");
         double tpPrice = JsonNum(o, "tpPrice");

         if (StringLen(symbol) == 0 || StringLen(dir) == 0 || lots <= 0.0) {
            Print("SybexForexAI: skipping malformed order id=", id);
            completed += "{\"id\":\"" + id + "\",\"success\":false,\"error\":\"malformed\"}";
            continue;
         }

         double filled = 0;
         bool   ok     = OpenOrder(symbol, dir, lots, slPrice, tpPrice, filled);
         Print("SybexForexAI: ", dir, " ", lots, " ", symbol,
               " SL=", slPrice, " TP=", tpPrice,
               " filled=", DoubleToString(filled, 5), " → ", ok ? "OK" : "FAILED");

         int dp = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
         completed += "{\"id\":\"" + id
                    + "\",\"success\":" + (ok ? "true" : "false")
                    + ",\"filledPrice\":" + DoubleToString(filled, dp) + "}";
      }
   }
   completed += "]";
   return completed;
}

//+------------------------------------------------------------------+
//| Build open positions JSON (only EA-managed positions)             |
//+------------------------------------------------------------------+
string BuildOpenPositionsJSON() {
   string out = "[";
   bool first = true;
   for (int i = 0; i < PositionsTotal(); i++) {
      ulong ticket = PositionGetTicket(i);
      if (!PositionSelectByTicket(ticket)) continue;
      if (PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;
      string sym = PositionGetString(POSITION_SYMBOL);
      int    dp  = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      if (!first) out += ",";
      out += "{\"ticket\":"  + IntegerToString((long)ticket)
           + ",\"symbol\":\"" + sym + "\""
           + ",\"type\":\""   + (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "BUY" : "SELL") + "\""
           + ",\"lots\":"     + DoubleToString(PositionGetDouble(POSITION_VOLUME), 2)
           + ",\"openPrice\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), dp)
           + ",\"sl\":"       + DoubleToString(PositionGetDouble(POSITION_SL), dp)
           + ",\"tp\":"       + DoubleToString(PositionGetDouble(POSITION_TP), dp)
           + ",\"profit\":"   + DoubleToString(PositionGetDouble(POSITION_PROFIT), 2)
           + "}";
      first = false;
   }
   out += "]";
   return out;
}

//+------------------------------------------------------------------+
//| Build bid/ask prices JSON for all symbols                         |
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
      if (!first) out += ",";
      out += "\"" + sym + "\":{\"bid\":" + DoubleToString(bid, dp)
           + ",\"ask\":" + DoubleToString(ask, dp) + "}";
      first = false;
   }
   out += "}";
   return out;
}

//+------------------------------------------------------------------+
//| Build M5 OHLCV candle array for one symbol                        |
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
   out += "]";
   return out;
}

//+------------------------------------------------------------------+
//| Build candles JSON for all symbols (M5)                           |
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
//| POST balance + market data + completed orders to the app          |
//+------------------------------------------------------------------+
void SendDataToApp() {
   string body = "{"
      + "\"balance\":"         + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2)
      + ",\"equity\":"         + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY),  2)
      + ",\"currency\":\""     + AccountInfoString(ACCOUNT_CURRENCY)                  + "\""
      + ",\"login\":\""        + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))   + "\""
      + ",\"server\":\""       + AccountInfoString(ACCOUNT_SERVER)                    + "\""
      + ",\"prices\":"         + BuildPricesJSON()
      + ",\"candles\":"        + BuildCandlesJSON()
      + ",\"openPositions\":"  + BuildOpenPositionsJSON()
      + ",\"completedOrders\":" + g_completedJson
      + "}";

   string headers     = "Content-Type: application/json\r\n";
   string respHeaders = "";
   char   post[], result[];
   StringToCharArray(body, post, 0, StringLen(body));

   ResetLastError();
   int res = WebRequest("POST", WebhookURL, headers, 10000, post, result, respHeaders);
   if (res == -1) {
      Print("SybexForexAI sync FAILED (err=", GetLastError(),
            "). Ensure URL is in Tools→Options→Expert Advisors→Allowed URLs");
   } else {
      Print("SybexForexAI sync OK"
            " | Balance: ", DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2),
            " | Pairs: ",   g_totalSymbols,
            " | Pos: ",     PositionsTotal(),
            " | HTTP: ",    res);
   }
}
