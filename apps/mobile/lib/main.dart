import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:video_player/video_player.dart';
import 'client.dart';
import 'uploader.dart';
void main()=>runApp(const StreamForge());
class StreamForge extends StatelessWidget {
  const StreamForge({super.key});
  @override Widget build(BuildContext context)=>MaterialApp(title:'StreamForge',theme:ThemeData(colorScheme:ColorScheme.fromSeed(seedColor:const Color(0xffef6b3f)),useMaterial3:true),home:const LibraryPage());
}
class LibraryPage extends StatefulWidget {const LibraryPage({super.key});@override State<LibraryPage> createState()=>_LibraryState();}
class _LibraryState extends State<LibraryPage> {
  final api=ApiClient();late final uploader=UploadController(api);final email=TextEditingController();final password=TextEditingController();
  bool signedIn=false,busy=false,offline=false;String? workspace;List<dynamic> workspaces=[],videos=[];String message='';double progress=0;
  @override void initState(){super.initState();restore();}
  Future<void> restore() async {try{await api.refresh();if(!mounted)return;setState(()=>signedIn=true);await loadWorkspaces();}catch(_){}}
  void error(Object e){if(mounted)setState(()=>message=e.toString());}
  Future<void> loadWorkspaces() async {try{workspaces=await api.call('/workspaces');if(workspaces.isNotEmpty){workspace??=workspaces.first['id'];await reload();}if(mounted)setState((){});}catch(e){error(e);}}
  Future<void> reload() async {if(workspace==null)return;final prefs=await SharedPreferences.getInstance();try{final data=await api.call('/videos?workspaceId=$workspace');videos=data['items'];await prefs.setString('library:$workspace',jsonEncode(videos));offline=false;}catch(e){final cached=prefs.getString('library:$workspace');if(cached!=null){videos=jsonDecode(cached);offline=true;}else{rethrow;}}if(mounted)setState((){});}
  Future<void> login() async {setState(()=>busy=true);try{await api.login(email.text,password.text);setState(()=>signedIn=true);await loadWorkspaces();}catch(e){error(e);}finally{if(mounted)setState(()=>busy=false);}}
  Future<void> chooseUpload() async {final chosen=await FilePicker.platform.pickFiles(type:FileType.custom,allowedExtensions:['mp4','mov','webm','mkv']);if(chosen?.files.single.path==null||workspace==null)return;setState(()=>busy=true);try{await uploader.upload(File(chosen!.files.single.path!),workspace!,(p,m){if(mounted)setState((){progress=p;message=m;});});await reload();}catch(e){error(e);}finally{if(mounted)setState(()=>busy=false);}}
  @override void dispose(){uploader.paused=true;email.dispose();password.dispose();super.dispose();}
  @override Widget build(BuildContext context)=>Scaffold(appBar:AppBar(title:const Text('StreamForge'),actions:[if(signedIn)IconButton(icon:const Icon(Icons.logout),onPressed:()async{await api.logout();setState(()=>signedIn=false);})]),body:!signedIn?Padding(padding:const EdgeInsets.all(24),child:Column(children:[const Text('Sign in with your verified account'),TextField(controller:email,decoration:const InputDecoration(labelText:'Email'),keyboardType:TextInputType.emailAddress),TextField(controller:password,decoration:const InputDecoration(labelText:'Password'),obscureText:true),const SizedBox(height:24),FilledButton(onPressed:busy?null:login,child:const Text('Sign in')),Text(message)])):Column(children:[if(workspaces.isNotEmpty)Padding(padding:const EdgeInsets.all(16),child:DropdownButton<String>(isExpanded:true,value:workspace,items:workspaces.map((w)=>DropdownMenuItem<String>(value:w['id'],child:Text(w['name']))).toList(),onChanged:(id){setState(()=>workspace=id);reload().catchError(error);})),if(offline)const Text('Offline · Cached metadata'),if(message.isNotEmpty)Padding(padding:const EdgeInsets.all(12),child:Text(message)),if(busy)LinearProgressIndicator(value:progress),if(busy)TextButton(onPressed:(){uploader.paused=true;setState(()=>message='Pausing after current chunk. Select the same file to resume.');},child:const Text('Pause upload')),Expanded(child:RefreshIndicator(onRefresh:reload,child:ListView(children:[if(videos.isEmpty)const Padding(padding:EdgeInsets.all(32),child:Text('Your videos will appear here. Create a workspace on the web to get started.')),for(final v in videos)ListTile(leading:const Icon(Icons.video_library_outlined),title:Text(v['title']),subtitle:Text('${v['status']} · ${v['privacy']}'),trailing:const Icon(Icons.chevron_right),onTap:()=>Navigator.push(context,MaterialPageRoute(builder:(_)=>VideoPage(api:api,video:v))))])))]),floatingActionButton:signedIn&&workspace!=null?FloatingActionButton.extended(onPressed:busy?null:chooseUpload,icon:const Icon(Icons.upload),label:const Text('Upload')):null);
}
class VideoPage extends StatefulWidget {final ApiClient api;final dynamic video;const VideoPage({super.key,required this.api,required this.video});@override State<VideoPage> createState()=>_VideoState();}
class _VideoState extends State<VideoPage> {
 VideoPlayerController? player;String message='Loading';dynamic analytics;
 @override void initState(){super.initState();load();}
 Future<void> load()async{try{final v=await widget.api.call('/videos/${widget.video['id']}');if(v['status']!='ready'){setState(()=>message='${v['status']}: ${v['progress']}');return;}final p=await widget.api.call('/videos/${v['id']}/playback');final controller=VideoPlayerController.networkUrl(Uri.parse(p['url']));await controller.initialize();final saved=await widget.api.call('/videos/${v['id']}/progress');await controller.seekTo(Duration(seconds:(saved['position'] as num).toInt()));analytics=await widget.api.call('/videos/${v['id']}/analytics');if(!mounted){await controller.dispose();return;}setState(()=>player=controller);}catch(e){if(mounted)setState(()=>message=e.toString());}}
 @override void dispose(){final p=player;if(p!=null){widget.api.call('/videos/${widget.video['id']}/progress',method:'PUT',body:{'position':p.value.position.inSeconds}).catchError((_){return null;});p.dispose();}super.dispose();}
 @override Widget build(BuildContext context)=>Scaffold(appBar:AppBar(title:Text(widget.video['title'])),body:Padding(padding:const EdgeInsets.all(16),child:Column(children:[if(player!=null)...[AspectRatio(aspectRatio:player!.value.aspectRatio,child:VideoPlayer(player!)),VideoProgressIndicator(player!,allowScrubbing:true),IconButton(icon:Icon(player!.value.isPlaying?Icons.pause:Icons.play_arrow),onPressed:(){setState((){player!.value.isPlaying?player!.pause():player!.play();});}),Text('${analytics?['plays']??0} plays · ${analytics?['watch_seconds']??0}s watch time')]else...[Text(message),TextButton(onPressed:load,child:const Text('Refresh progress'))]])));
}
