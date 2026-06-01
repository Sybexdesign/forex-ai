//+------------------------------------------------------------------+
//| SybexForexAI Balance Sync EA v6                                  |
//| Posts DIRECTLY to Supabase RPC -- bypasses Vercel entirely.      |
//| v5 fix: ORDER_FILLING_RETURN (IOC caused all orders to reject).  |
//| v6 fix: split fast order-poll (2s) from heavy data sync (10s)    |
//|         so scalp orders are picked up in ~2s instead of ~30s.    |
//+------------------------------------------------------------------+
#property strict
#property description "SybexForexAI v6 -- fast order polling"

//--- Inputs -----------------------------------------------------------
input string WebhookToken        = "c4fdfa3e21314a9fbf57fd7b3ffa30c4";
input int    OrderPollSeconds     = 2;   // how often to check for new pending orders
input int    DataSyncSeconds      = 10;  // how often to push full market data (candles, balance, positions)
input int    CandleBars           = 200;
input int    CandleBarsHTF        = 100;
input int    MagicNumber          = 20260001;
input int    SlippagePoints       = 10;
input ENUM_ORDER_TYPE_FILLING FillMode = ORDER_FILLING_RETURN;

string SYMBOLS[] = {"EURUSD","GBPUSD","USDJPY","AUDUSD","XAUUSD","XAGUSD","USDCAD"};

//--- Constants --------------------------------------------------------
string SYNC_URL = "https://lfurosnmkwvqtlifggaa.supabase.co/rest/v1/rpc/mt5_webhook_sync";
string ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxmdXJvc25ta3d2cXRsaWZnZ2FhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3MjQ4MzEsImV4cCI6MjA5MzMwMDgzMX0.ZWxFA-D57GqObQM_jSQ2PvNbqfxPOY4YBd__XZiFeWA";

//--- Globals ----------------------------------------------------------
int    g_totalSymbols  = 0;
string g_completedJson = "[]";
int    g_syncCounter   = 0;   // counts order-poll ticks; triggers full sync every N ticks
int    g_syncEveryN    = 5;   // = DataSyncSeconds / OrderPollSeconds

//+------------------------------------------------------------------+
int OnInit()
{
   g_totalSymbols = ArraySize(SYMBOLS);
   g_syncEveryN   = MathMax(1, DataSyncSeconds / OrderPollSeconds);
   EventSetTimer(OrderPollSeconds);
   Print("SybexForexAI v6 started | FillMode=", EnumToString(FillMode),
         " | OrderPoll=", OrderPollSeconds, "s | DataSync=", DataSyncSeconds, "s",
         " | Token prefix: ", StringSubstr(WebhookToken,0,8));
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { EventKillTimer(); }

//+------------------------------------------------------------------+
void OnTimer()
{
   // ── Fast path: always check for pending orders ──────────────────
   string resp = FetchPendingOrders();
   if(StringLen(resp) > 10)
   {
      int cnt = 0, sp = 0;
      while(StringFind(resp, "\"id\":", sp) >= 0) { sp = StringFind(resp,"\"id\":",sp)+1; cnt++; }
      if(cnt > 0)
      {
         Print("SybexForexAI v6: ", cnt, " pending order(s) -- executing...");
         g_completedJson = ExecuteOrders(resp);
         Print("SybexForexAI v6: completedOrders=", g_completedJson);
      }
   }

   // ── Slow path: full data push every DataSyncSeconds ─────────────
   // Also triggers immediately after any order executes so fill
   // prices are reflected in the app without waiting for next cycle.
   bool ordersJustFilled = (g_completedJson != "[]");
   g_syncCounter++;
   if(g_syncCounter >= g_syncEveryN || ordersJustFilled)
   {
      g_syncCounter  = 0;
      SendDataToApp();
      g_completedJson = "[]";
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
      Print("SybexForexAI v6: pull FAILED err=", GetLastError(),
            " -- add URL to Tools>Options>Expert Advisors>Allowed URLs");
      return "";
   }
   if(rc != 200)
   {
      Print("SybexForexAI v6: pull HTTP ", rc);
      return "";
   }
   string r = CharArrayToString(result);
   return r;
}

//+------------------------------------------------------------------+
void SendDataToApp()
{
   string body = "{"
      + "\"p_token\":\"" + WebhookToken + "\","
      + "\"p_payload\":{"
      + "\"balance\":"         + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE),2)
      + ",\"equity\":"         + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY),2)
      + ",\"currency\":\""     + AccountInfoString(ACCOUNT_CURRENCY) + "\""
      + ",\"login\":\""        + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "\""
      + ",\"server\":\""       + AccountInfoString(ACCOUNT_SERVER) + "\""
      + ",\"prices\":"         + BuildPricesJSON()
      + ",\"candles\":"        + BuildCandlesJSON()
      + ",\"openPositions\":"  + BuildOpenPositionsJSON()
      + ",\"completedOrders\":" + g_completedJson
      + "}}";

   char post[], result[];
   string respHdr = "";
   StringToCharArray(body, post, 0, StringLen(body));
   ArrayResize(post, StringLen(body));

   ResetLastError();
   int rc = WebRequest("POST", SYNC_URL, BuildHeaders(), 15000, post, result, respHdr);
   if(rc == -1)
      Print("SybexForexAI v6: push FAILED err=", GetLastError());
   else if(rc == 200)
      Print("SybexForexAI v6: push OK | Bal=",
            DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE),2),
            " Pos=", PositionsTotal());
   else
      Print("SybexForexAI v6: push HTTP ", rc, " -- ", StringSubstr(CharArrayToString(result),0,200));
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
      double bid = SymbolInfoDouble(SYMBOLS[i], SYMBOL_BID);
      double ask = SymbolInfoDouble(SYMBOLS[i], SYMBOL_ASK);
      if(bid <= 0 || ask <= 0) continue;
      int dp = (int)SymbolInfoInteger(SYMBOLS[i], SYMBOL_DIGITS);
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
      string arr = BuildCandleArray(SYMBOLS[i], period, bars);
      if(arr == "[]") continue;
      if(!first) out += ",";
      out += "\"" + SYMBOLS[i] + "\":" + arr;
      first = false;
   }
   return out + "}";
}

//+------------------------------------------------------------------+
string BuildCandlesJSON()
{
   return "{"
      + "\"M5\":"   + BuildCandlesForTF(PERIOD_M5,  CandleBars)
      + ",\"M15\":" + BuildCandlesForTF(PERIOD_M15, CandleBarsHTF)
      + ",\"H1\":"  + BuildCandlesForTF(PERIOD_H1,  CandleBarsHTF)
      + ",\"H4\":"  + BuildCandlesForTF(PERIOD_H4,  50)
      + "}";
}

//+------------------------------------------------------------------+
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
           + ",\"symbol\":\""  + PositionGetString(POSITION_SYMBOL) + "\""
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
// PlaceOrder: tries FillMode first, then FOK, then IOC as fallbacks.
// Retcode 10015 = invalid filling -- safe to retry with next mode.
//+------------------------------------------------------------------+
bool PlaceOrder(string symbol, string direction, double lots,
                double slPrice, double tpPrice,
                double &filledPrice, int &retcode)
{
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
      req.symbol       = symbol;
      req.volume       = lots;
      req.type         = (direction == "BUY") ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
      req.price        = (direction == "BUY")
                         ? SymbolInfoDouble(symbol, SYMBOL_ASK)
                         : SymbolInfoDouble(symbol, SYMBOL_BID);
      req.sl           = slPrice;
      req.tp           = tpPrice;
      req.deviation    = SlippagePoints;
      req.magic        = MagicNumber;
      req.type_filling = modes[f];

      bool ok  = OrderSend(req, res);
      retcode  = (int)res.retcode;

      if(ok && res.retcode == 10009) // 10009 = TRADE_RETCODE_DONE
      {
         filledPrice = res.price;
         if(f > 0) Print("SybexForexAI v6: used fallback fill mode ", EnumToString(modes[f]));
         return true;
      }

      if(res.retcode != 10015 && res.retcode != 10030) // 10015=invalid price/fill, 10030=invalid fill type -- retry with next mode
      {
         Print("SybexForexAI v6: order FAILED ", symbol, " ", direction,
               " retcode=", res.retcode, " fill=", EnumToString(modes[f]));
         return false;
      }
      Print("SybexForexAI v6: fill mode ", EnumToString(modes[f]),
            " rejected -- trying next mode...");
   }
   return false;
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

   string arr = StringSubstr(response, arrStart, arrEnd - arrStart + 1);
   int searchPos = 0;

   while(true)
   {
      int objStart = StringFind(arr, "{", searchPos);
      if(objStart < 0) break;
      int objEnd = StringFind(arr, "}", objStart);
      if(objEnd < 0) break;

      string obj       = StringSubstr(arr, objStart, objEnd - objStart + 1);
      string orderId   = JsonStr(obj, "id");
      string symbol    = JsonStr(obj, "symbol");
      string direction = JsonStr(obj, "direction");
      double lots      = JsonNum(obj, "lots");
      double slPrice   = JsonNum(obj, "slPrice");
      double tpPrice   = JsonNum(obj, "tpPrice");

      if(StringLen(orderId) > 0 && StringLen(symbol) > 0 && lots > 0)
      {
         if(!first) completed += ",";
         bool isClose = (StringFind(obj, "\"type\":\"close\"") >= 0);

         if(isClose)
         {
            for(int i = PositionsTotal()-1; i >= 0; i--)
            {
               ulong ticket = PositionGetTicket(i);
               if(ticket == 0) continue;
               if(PositionGetString(POSITION_SYMBOL) != symbol) continue;

               MqlTradeRequest req;
               MqlTradeResult  res2;
               ZeroMemory(req);
               ZeroMemory(res2);

               req.action       = TRADE_ACTION_DEAL;
               req.symbol       = symbol;
               req.volume       = PositionGetDouble(POSITION_VOLUME);
               req.type         = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY)
                                  ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
               req.price        = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY)
                                  ? SymbolInfoDouble(symbol, SYMBOL_BID)
                                  : SymbolInfoDouble(symbol, SYMBOL_ASK);
               req.deviation    = SlippagePoints;
               req.magic        = MagicNumber;
               req.position     = ticket;
               req.type_filling = FillMode;

               if(!OrderSend(req, res2))
                  Print("SybexForexAI v6: close failed ticket=", ticket, " retcode=", res2.retcode);
            }
            completed += "{\"id\":\"" + orderId + "\",\"success\":true,\"type\":\"close\"}";
            Print("SybexForexAI v6: close sent for ", symbol);
         }
         else
         {
            double filledPrice = 0;
            int    retcode     = 0;
            bool   ok = PlaceOrder(symbol, direction, lots, slPrice, tpPrice, filledPrice, retcode);

            if(ok)
            {
               completed += "{\"id\":\"" + orderId + "\",\"success\":true"
                          + ",\"filledPrice\":" + DoubleToString(filledPrice,5) + "}";
               Print("SybexForexAI v6: FILLED ", symbol, " ", direction,
                     " lots=", lots, " @ ", filledPrice);
            }
            else
            {
               completed += "{\"id\":\"" + orderId + "\",\"success\":false"
                          + ",\"error\":\"retcode " + IntegerToString(retcode) + "\"}";
               Print("SybexForexAI v6: REJECTED ", symbol, " retcode=", retcode);
            }
         }
         first = false;
      }
      searchPos = objEnd + 1;
   }
   return completed + "]";
}
