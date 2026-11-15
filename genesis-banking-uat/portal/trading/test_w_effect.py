import time
import math
import unittest
from w_effect import validate_w,index_allows,WEffectStrategy

def fixture():
 now=int(time.time()*1000)
 ticks=[]
 for i in range(250):
  mid=101+math.sin(i)*.05
  if 80<=i<160:mid=101.5+math.sin(i)*.05
  if 160<=i<240:mid=100.5+math.sin(i)*.05
  if i==60:mid=99
  if i==120:mid=102
  if i==200:mid=99.1
  if i>=240:mid=101.7+(i-240)*.045
  ticks.append(dict(bid=round(mid-.01,5),ask=round(mid+.01,5),bidSize=2.,askSize=1.,sellVolume=10. if 56<=i<=64 else .5 if 196<=i<=204 else 1.,tsMicros=(now-249+i)*1000))
 return ticks
class Tests(unittest.TestCase):
 def test_w(self):
  ticks=fixture();p=validate_w(ticks);self.assertIsNotNone(p);self.assertEqual(p['l1'],99);self.assertEqual(p['l2'],99.1)
  self.assertIsNone(validate_w(ticks[:60]));self.assertIsNone(validate_w(ticks[:240]))
  for change in ('volume','low','breakout','imbalance','spread'):
   t=[x.copy() for x in ticks]
   if change=='volume':
    for x in t[196:205]:x['sellVolume']=20
   if change=='low':t[200]['bid']=95;t[200]['ask']=95.01
   if change=='breakout':t[-1]['bid']=101;t[-1]['ask']=101.01
   if change=='imbalance':t[-1]['bidSize']=1
   if change=='spread':t[-1]['ask']=105
   self.assertIsNone(validate_w(t),change)
 def test_index(self):
  now=int(time.time()*1000);i=dict(instrumentId='BTC',score=10,confidence=.4,sourceCount=3,generatedAtMs=now-1000,validUntilMs=now+1000)
  self.assertTrue(index_allows(i,'BTC',now))
  for patch in [dict(score=-10),dict(instrumentId='ETH'),dict(validUntilMs=now-1),dict(generatedAtMs=now+1),dict(confidence=.1),dict(sourceCount=1)]:self.assertFalse(index_allows(i|patch,'BTC',now))
 def test_real_nautilus_order_and_stop(self):
  s=WEffectStrategy(dict(id='r',symbol='BTCUSDT',venue='BINANCE',indexId='BTC',maxNotional='1000',quantityStep='0.01',priceTick='0.01',trailingBps=50));ticks=fixture();now=ticks[-1]['tsMicros']//1000
  s.index=dict(instrumentId='BTC',score=20,confidence=.5,sourceCount=3,generatedAtMs=now-1000,validUntilMs=now+100000,sequence='seq')
  result=None
  for t in ticks:result=s.receive(t,now)
  self.assertEqual(result['order']['time_in_force'],'IOC');self.assertEqual(result['side'],'BUY');self.assertGreater(float(result['quantity']),0)
  self.assertIsNone(s.receive(ticks[-1],now));s.acknowledge(dict(positionQuantity='2',stopPrice='100',peakPrice='102'))
  tick=dict(ticks[-1],bid=98.,ask=98.01,tsMicros=(now+6000)*1000);s.index=None
  sell=s.receive(tick,now+6000);self.assertEqual(sell['side'],'SELL');self.assertEqual(float(sell['quantity']),2)
  s.acknowledge(dict(positionQuantity='1',stopPrice='100',peakPrice='102'));tick['tsMicros']+=6000000
  self.assertEqual(float(s.receive(tick,now+12000)['quantity']),1)
 def test_benchmark(self):
  ticks=fixture();start=time.perf_counter()
  for _ in range(1000):validate_w(ticks)
  elapsed=time.perf_counter()-start
  print(f'W evaluation: {1000/elapsed:.0f}/second; {elapsed:.3f} ms average per 250-tick window')
  self.assertLess(elapsed,10)
if __name__=='__main__':unittest.main()
