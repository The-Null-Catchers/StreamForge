import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'client.dart';
class UploadController {
  final ApiClient api;
  bool paused = false;
  UploadController(this.api);
  Future<void> upload(File file, String workspaceId, void Function(double,String) progress) async {
    paused=false; progress(0,'Checking file integrity');
    final checksum=(await sha256.bind(file.openRead()).first).toString();
    if(paused)return;
    final prefs=await SharedPreferences.getInstance(); final key='upload:$workspaceId:$checksum';
    String? id=prefs.getString(key); final size=await file.length();
    if(id!=null) {final current=await api.call('/uploads/$id'); if(current['status']!='uploading'){id=null;await prefs.remove(key);}}
    if(id==null) {
      final filename=file.uri.pathSegments.last;
      final video=await api.call('/videos',method:'POST',body:{'workspaceId':workspaceId,'title':filename});
      final extension=filename.split('.').last.toLowerCase();
      final mime={'mp4':'video/mp4','mov':'video/quicktime','webm':'video/webm','mkv':'video/x-matroska'}[extension];
      if(mime==null)throw Exception('Choose MP4, MOV, WebM or MKV');
      final upload=await api.call('/uploads',method:'POST',body:{'workspaceId':workspaceId,'videoId':video['id'],'filename':filename,'mimeType':mime,'totalSize':size,'checksum':checksum});
      id=upload['id'];await prefs.setString(key,id!);
    }
    final state=await api.call('/uploads/$id'); final chunk=state['chunk_size'] as int;
    final done=(state['parts'] as List).map((p)=>p['part_number'] as int).toSet();
    int bytes=int.parse(state['uploaded_bytes'].toString());final raf=await file.open();
    try {
      for(int part=0;part<(size/chunk).ceil();part++) {
        if(paused)return;if(done.contains(part))continue;await raf.setPosition(part*chunk);final data=await raf.read(chunk);
        for(int attempt=0;attempt<4;attempt++) {
          try {await api.call('/uploads/$id/parts/$part',method:'PUT',body:data,headers:{'Content-Type':'application/octet-stream','X-Checksum-Sha256':sha256.convert(data).toString()});break;}
          catch(_){if(attempt==3)rethrow;await Future.delayed(Duration(seconds:1<<attempt));if(paused)return;}
        }
        bytes+=data.length;progress(bytes/size,'Uploading ${(bytes/size*100).round()}%');
      }
      await api.call('/uploads/$id/complete',method:'POST',body:{});await prefs.remove(key);progress(1,'Processing started');
    } finally {await raf.close();}
  }
}
